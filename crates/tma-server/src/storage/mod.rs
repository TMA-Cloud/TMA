//! The S3-compatible bucket every file body lives in. The configuration comes
//! from `app_settings`; each process keeps the decrypted copy in memory only and
//! re-reads it after a short TTL, building a new client when the version moves.

pub mod config;
pub mod probe;
pub mod sizing;
mod upload;

pub use config::StorageConfig;
pub use upload::UploadSink;

use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier};
use bytes::Bytes;
use futures::Stream;
use sqlx::PgPool;
use tokio::sync::RwLock;

use crate::crypto::Keyring;
use crate::error::DomainError;

const CONFIG_TTL: Duration = Duration::from_secs(15);
/// DeleteObjects requests sent at once.
const PARALLEL_DELETES: usize = 8;

/// One DeleteObjects request (up to 1,000 keys); returns the keys that failed.
async fn delete_batch(a: &Active, keys: &[String]) -> Result<Vec<(String, String)>> {
    let objects = keys
        .iter()
        .map(|k| ObjectIdentifier::builder().key(k).build())
        .collect::<Result<Vec<_>, _>>()
        .context("invalid object key")?;
    let delete = Delete::builder().set_objects(Some(objects)).quiet(true).build().context("invalid delete request")?;
    let out =
        a.client.delete_objects().bucket(&a.bucket).delete(delete).send().await.context("DeleteObjects failed")?;
    Ok(out
        .errors()
        .iter()
        .map(|e| (e.key().unwrap_or_default().to_string(), e.message().unwrap_or("Deletion failed").to_string()))
        .collect())
}

/// A stream of object bytes.
pub type ByteStreamBox = Pin<Box<dyn Stream<Item = Result<Bytes>> + Send>>;

/// Size and age of a stored object.
#[derive(Debug, Clone, Copy)]
pub struct ObjectStat {
    pub size: u64,
    pub last_modified: Option<chrono::DateTime<chrono::Utc>>,
}

/// One listed object.
#[derive(Debug, Clone)]
pub struct ListedObject {
    pub key: String,
    pub size: i64,
    pub last_modified: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone)]
pub struct Active {
    pub version: i32,
    pub client: Client,
    pub bucket: String,
}

#[derive(Clone)]
pub struct Storage {
    pool: PgPool,
    keyring: Arc<Keyring>,
    state: Arc<RwLock<(Option<Active>, Option<Instant>)>>,
}

/// A client for one configuration.
pub fn build_client(config: &StorageConfig, timeouts: Option<(Duration, Duration)>) -> Client {
    let creds = Credentials::new(&config.access_key_id, &config.secret_access_key, None, None, "tma-cloud");
    let mut builder = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(config.region.clone()))
        .endpoint_url(&config.endpoint)
        .credentials_provider(creds)
        .force_path_style(config.force_path_style)
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired);
    if let Some((connect, request)) = timeouts {
        builder = builder
            .timeout_config(
                aws_sdk_s3::config::timeout::TimeoutConfig::builder()
                    .connect_timeout(connect)
                    .operation_timeout(request)
                    .build(),
            )
            .retry_config(aws_sdk_s3::config::retry::RetryConfig::disabled());
    }
    Client::from_conf(builder.build())
}

/// Turn an SDK body into a byte stream.
pub fn body_stream(body: ByteStream) -> ByteStreamBox {
    Box::pin(futures::stream::unfold(body, |mut body| async move {
        body.next().await.map(|item| (item.map_err(anyhow::Error::from), body))
    }))
}

fn is_not_found<E: ProvideErrorMetadata>(err: &aws_sdk_s3::error::SdkError<E>) -> bool {
    if let aws_sdk_s3::error::SdkError::ServiceError(service) = err
        && service.raw().status().as_u16() == 404
    {
        return true;
    }
    matches!(err.code(), Some("NotFound" | "NoSuchKey"))
}

impl Storage {
    pub fn new(pool: PgPool, keyring: Arc<Keyring>) -> Self {
        Self { pool, keyring, state: Arc::new(RwLock::new((None, None))) }
    }

    /// The client and bucket for the current configuration, or "not configured".
    pub async fn active(&self) -> Result<Active> {
        {
            let guard = self.state.read().await;
            if guard.1.is_some_and(|at| at.elapsed() < CONFIG_TTL) {
                return guard.0.clone().ok_or_else(|| DomainError::StorageNotConfigured.into());
            }
        }
        let config = config::load(&self.pool, &self.keyring).await?;
        let mut guard = self.state.write().await;
        let next = match config {
            None => None,
            Some(cfg) => match &guard.0 {
                Some(active) if active.version == cfg.version => Some(active.clone()),
                _ => {
                    Some(Active { version: cfg.version, client: build_client(&cfg, None), bucket: cfg.bucket.clone() })
                }
            },
        };
        *guard = (next.clone(), Some(Instant::now()));
        next.ok_or_else(|| DomainError::StorageNotConfigured.into())
    }

    /// Whether a bucket is configured (cached).
    pub async fn is_configured(&self) -> bool {
        self.active().await.is_ok()
    }

    /// Drop the cached client after this process saved a new configuration.
    pub async fn invalidate(&self) {
        self.state.write().await.1 = None;
    }

    pub async fn stat(&self, key: &str) -> Result<Option<ObjectStat>> {
        let a = self.active().await?;
        match a.client.head_object().bucket(&a.bucket).key(key).send().await {
            Ok(out) => Ok(Some(ObjectStat {
                size: out.content_length().unwrap_or(0).max(0) as u64,
                last_modified: out
                    .last_modified()
                    .and_then(|t| chrono::DateTime::from_timestamp(t.secs(), t.subsec_nanos())),
            })),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(anyhow::Error::from(err).context(format!("HeadObject failed for {key}"))),
        }
    }

    pub async fn exists(&self, key: &str) -> Result<bool> {
        Ok(self.stat(key).await?.is_some())
    }

    /// Object bytes, optionally limited to the inclusive range `[start, end]`.
    pub async fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<ByteStreamBox> {
        let a = self.active().await?;
        let mut req = a.client.get_object().bucket(&a.bucket).key(key);
        if let Some((start, end)) = range {
            req = req.range(format!("bytes={start}-{end}"));
        }
        let out = req.send().await.with_context(|| format!("GetObject failed for {key}"))?;
        Ok(body_stream(out.body))
    }

    /// Read a small object fully (headers, probes).
    pub async fn get_bytes(&self, key: &str, range: Option<(u64, u64)>) -> Result<Vec<u8>> {
        use futures::StreamExt;
        let mut stream = self.get(key, range).await?;
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            out.extend_from_slice(&chunk?);
        }
        Ok(out)
    }

    /// A sink that streams an unknown-length body to `key`, switching to a
    /// multipart upload once it outgrows one part.
    pub async fn upload_sink(&self, key: &str, maximum_len: u64) -> Result<UploadSink> {
        let a = self.active().await?;
        let part =
            sizing::part_size_for(maximum_len.min(sizing::MAX_PORTABLE_OBJECT_SIZE), sizing::DEFAULT_UPLOAD_PART_SIZE)
                .map_err(anyhow::Error::msg)?;
        Ok(UploadSink::new(a, key.to_string(), part as usize))
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        let a = self.active().await?;
        a.client
            .delete_object()
            .bucket(&a.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("DeleteObject failed for {key}"))?;
        Ok(())
    }

    /// Delete any number of objects in 1,000-key batches; returns the keys that failed.
    pub async fn delete_many(&self, keys: &[String]) -> Result<Vec<(String, String)>> {
        let mut unique: Vec<String> = keys.iter().filter(|k| !k.is_empty()).cloned().collect();
        unique.sort();
        unique.dedup();
        if unique.is_empty() {
            return Ok(Vec::new());
        }
        use futures::StreamExt;
        let a = self.active().await?;
        // Several requests at once: each can take a second for 1,000 keys, and a large
        // permanent delete sends dozens.
        let requests: Vec<_> = unique.chunks(1000).map(|chunk| delete_batch(&a, chunk)).collect();
        let answers: Vec<Result<Vec<(String, String)>>> =
            futures::stream::iter(requests).buffer_unordered(PARALLEL_DELETES).collect().await;
        let mut errors = Vec::new();
        for answer in answers {
            errors.extend(answer?);
        }
        Ok(errors)
    }

    /// Server-side copy; objects over 5 GB use parallel UploadPartCopy.
    pub async fn copy(&self, source: &str, dest: &str, source_size: Option<u64>) -> Result<()> {
        let a = self.active().await?;
        let size = match source_size {
            Some(s) => s,
            None => self.stat(source).await?.map(|s| s.size).context("Source object not found")?,
        };
        let copy_source = format!(
            "{}/{}",
            a.bucket,
            percent_encoding::utf8_percent_encode(source, percent_encoding::NON_ALPHANUMERIC)
        );
        if !sizing::requires_multipart(size) {
            a.client
                .copy_object()
                .bucket(&a.bucket)
                .key(dest)
                .copy_source(copy_source)
                .send()
                .await
                .with_context(|| format!("CopyObject failed for {source}"))?;
            return Ok(());
        }
        self.multipart_copy(&a, &copy_source, dest, size).await
    }

    async fn multipart_copy(&self, a: &Active, copy_source: &str, dest: &str, size: u64) -> Result<()> {
        let part = sizing::part_size_for(size, sizing::DEFAULT_COPY_PART_SIZE).map_err(anyhow::Error::msg)?;
        let created = a.client.create_multipart_upload().bucket(&a.bucket).key(dest).send().await?;
        let upload_id = created.upload_id().context("Object store did not return a multipart upload id")?.to_string();
        let ranges: Vec<(i32, u64, u64)> =
            (0..size.div_ceil(part)).map(|i| (i as i32 + 1, i * part, ((i + 1) * part).min(size) - 1)).collect();
        let result: Result<Vec<CompletedPart>> = async {
            use futures::StreamExt;
            let results: Vec<Result<CompletedPart>> = futures::stream::iter(ranges)
                .map(|(number, start, end)| {
                    let client = a.client.clone();
                    let (bucket, dest, upload_id, source) =
                        (a.bucket.clone(), dest.to_string(), upload_id.clone(), copy_source.to_string());
                    async move {
                        let out = client
                            .upload_part_copy()
                            .bucket(bucket)
                            .key(dest)
                            .upload_id(upload_id)
                            .part_number(number)
                            .copy_source(source)
                            .copy_source_range(format!("bytes={start}-{end}"))
                            .send()
                            .await?;
                        let etag =
                            out.copy_part_result().and_then(|r| r.e_tag()).context("missing part ETag")?.to_string();
                        Ok(CompletedPart::builder().e_tag(etag).part_number(number).build())
                    }
                })
                .buffer_unordered(4)
                .collect()
                .await;
            let mut parts = results.into_iter().collect::<Result<Vec<_>>>()?;
            parts.sort_by_key(|p| p.part_number());
            Ok(parts)
        }
        .await;
        match result {
            Ok(parts) => {
                a.client
                    .complete_multipart_upload()
                    .bucket(&a.bucket)
                    .key(dest)
                    .upload_id(&upload_id)
                    .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
                    .send()
                    .await?;
                Ok(())
            }
            Err(err) => {
                let _ =
                    a.client.abort_multipart_upload().bucket(&a.bucket).key(dest).upload_id(&upload_id).send().await;
                Err(err)
            }
        }
    }

    /// One page of objects; pass the returned token to continue.
    pub async fn list_page(
        &self,
        token: Option<String>,
        page_size: i32,
    ) -> Result<(Vec<ListedObject>, Option<String>)> {
        let a = self.active().await?;
        let out = a
            .client
            .list_objects_v2()
            .bucket(&a.bucket)
            .max_keys(page_size)
            .set_continuation_token(token)
            .send()
            .await
            .context("ListObjectsV2 failed")?;
        let items = out
            .contents()
            .iter()
            .filter_map(|o| {
                Some(ListedObject {
                    key: o.key()?.to_string(),
                    size: o.size().unwrap_or(0),
                    last_modified: o
                        .last_modified()
                        .and_then(|t| chrono::DateTime::from_timestamp(t.secs(), t.subsec_nanos())),
                })
            })
            .collect();
        let next =
            if out.is_truncated().unwrap_or(false) { out.next_continuation_token().map(String::from) } else { None };
        Ok((items, next))
    }
}
