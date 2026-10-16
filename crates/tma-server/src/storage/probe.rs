//! Proves a candidate bucket configuration works before it is saved: the bucket
//! is reachable, the key can list, write, read back and delete, and (when files
//! already exist) the target still holds them.

use std::time::Duration;

use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::primitives::ByteStream;

use super::{StorageConfig, build_client};

const PROBE_PREFIX: &str = ".tma-cloud-probe/";
const MAX_PROBE_BODY: usize = 64 * 1024;

/// Which check failed and a message that helps without echoing provider internals.
#[derive(Debug, Clone)]
pub struct ProbeError {
    pub step: &'static str,
    pub message: String,
}

fn describe<E: ProvideErrorMetadata + std::fmt::Debug>(err: &SdkError<E>, bucket: &str) -> String {
    let status = match err {
        SdkError::ServiceError(s) => Some(s.raw().status().as_u16()),
        _ => None,
    };
    let code = err.code().unwrap_or("");
    if code == "NoSuchBucket" || (status == Some(404) && code != "NoSuchKey") {
        return format!("Bucket \"{bucket}\" was not found at this endpoint");
    }
    if matches!(code, "InvalidAccessKeyId" | "SignatureDoesNotMatch" | "InvalidToken") {
        return "The access key ID or secret access key was rejected".into();
    }
    if status == Some(403) || code == "AccessDenied" {
        return "Access denied: check the access key ID, the secret and the key's permissions on this bucket".into();
    }
    if matches!(code, "PermanentRedirect" | "AuthorizationHeaderMalformed") || status == Some(301) {
        return "The bucket is in a different region; check the region setting".into();
    }
    match err {
        SdkError::TimeoutError(_) => "The endpoint did not respond in time".into(),
        SdkError::DispatchFailure(d) => {
            let text = format!("{d:?}");
            if text.contains("certificate") || text.contains("Certificate") || text.contains("tls") {
                "The endpoint TLS certificate is not trusted".into()
            } else if d.is_timeout() {
                "The endpoint did not respond in time".into()
            } else {
                "Could not connect to the endpoint".into()
            }
        }
        _ => "The storage endpoint returned an unexpected error".into(),
    }
}

fn fail<'a, E: ProvideErrorMetadata + std::fmt::Debug>(
    step: &'static str,
    bucket: &'a str,
) -> impl Fn(SdkError<E>) -> ProbeError + 'a {
    move |err| {
        tracing::warn!(step, code = ?err.code(), "[Storage] Probe failed");
        ProbeError { step, message: describe(&err, bucket) }
    }
}

/// Run every check against a configuration that has not been saved yet.
pub async fn probe(config: &StorageConfig, sample_keys: &[String]) -> Result<Vec<String>, ProbeError> {
    let client = build_client(config, Some((Duration::from_secs(5), Duration::from_secs(15))));
    let bucket = config.bucket.as_str();
    let mut checks = Vec::new();

    client.head_bucket().bucket(bucket).send().await.map_err(fail("connect", bucket))?;
    checks.push("connect".to_string());

    client.list_objects_v2().bucket(bucket).max_keys(1).send().await.map_err(fail("list", bucket))?;
    checks.push("list".to_string());

    let key = format!("{PROBE_PREFIX}{}", uuid::Uuid::new_v4());
    let payload = crate::crypto::random_bytes::<32>().to_vec();
    client
        .put_object()
        .bucket(bucket)
        .key(&key)
        .content_length(payload.len() as i64)
        .body(ByteStream::from(payload.clone()))
        .send()
        .await
        .map_err(fail("write", bucket))?;
    checks.push("write".to_string());

    let read = async {
        let out = client.get_object().bucket(bucket).key(&key).send().await.map_err(fail("read", bucket))?;
        let mismatch =
            || ProbeError { step: "read", message: "An object read back differently from how it was written".into() };
        let mut body = out.body;
        let mut data = Vec::new();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|_| mismatch())?;
            data.extend_from_slice(&chunk);
            if data.len() > MAX_PROBE_BODY {
                return Err(mismatch());
            }
        }
        if data != payload { Err(mismatch()) } else { Ok(()) }
    }
    .await;
    let deleted = client.delete_object().bucket(bucket).key(&key).send().await.map_err(fail("delete", bucket));
    read?;
    checks.push("read".to_string());
    deleted?;
    checks.push("delete".to_string());

    if !sample_keys.is_empty() {
        let mut found = false;
        for sample in sample_keys {
            if client.head_object().bucket(bucket).key(sample).send().await.is_ok() {
                found = true;
                break;
            }
        }
        // Any hit proves this is the same store; zero means the files would all go missing.
        if !found {
            return Err(ProbeError {
                step: "existing-files",
                message: "This bucket does not contain the files already stored. Copy them across before switching."
                    .into(),
            });
        }
        checks.push("existing-files".to_string());
    }
    Ok(checks)
}
