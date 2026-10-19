//! Streaming an unknown-length body into the bucket: one PutObject when it fits
//! in a part, otherwise a multipart upload with a few parts in flight.
//!
//! Parts are buffered in memory, so many large uploads at once could exhaust
//! it (30 parallel ones held 1.5 GB). Buffers past the first MiB come out of a
//! server-wide budget, reserved a whole part at a time: an upload waits for a
//! reservation only while holding none, so holders always finish and free it,
//! and a waiting upload stops reading its body, which slows its sender.

use anyhow::{Context, Result, bail};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use bytes::{Bytes, BytesMut};
use std::sync::{Arc, LazyLock};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use super::Active;

const MAX_IN_FLIGHT: usize = 3;
/// Bytes an upload may buffer before it needs a reservation: most files are smaller.
const UNRESERVED: usize = 1024 * 1024;
/// The budget counts KiB.
const UNIT: usize = 1024;

/// Memory for upload buffers across the server, in KiB (UPLOAD_MEMORY_MB, default 512).
static BUDGET: LazyLock<(Arc<Semaphore>, usize)> = LazyLock::new(|| {
    let mb = std::env::var("UPLOAD_MEMORY_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 64)
        .unwrap_or(512);
    let units = mb * 1024 * 1024 / UNIT;
    (Arc::new(Semaphore::new(units)), units)
});

/// Reserve memory for one part, waiting while the budget is spent.
async fn reserve(bytes: usize) -> Result<OwnedSemaphorePermit> {
    let (budget, total) = &*BUDGET;
    let units = bytes.div_ceil(UNIT).min(*total) as u32;
    budget.clone().acquire_many_owned(units).await.context("upload memory budget closed")
}

pub struct UploadSink {
    active: Active,
    key: String,
    part_size: usize,
    buf: BytesMut,
    /// The budget held for what `buf` will grow to (one part), if any yet.
    reserved: Option<OwnedSemaphorePermit>,
    upload_id: Option<String>,
    next_part: i32,
    in_flight: JoinSet<Result<CompletedPart>>,
    parts: Vec<CompletedPart>,
    written: u64,
    finished: bool,
}

impl UploadSink {
    pub(super) fn new(active: Active, key: String, part_size: usize) -> Self {
        Self {
            active,
            key,
            part_size,
            buf: BytesMut::with_capacity(part_size.min(UNRESERVED)),
            reserved: None,
            upload_id: None,
            next_part: 1,
            in_flight: JoinSet::new(),
            parts: Vec::new(),
            written: 0,
            finished: false,
        }
    }

    /// Bytes accepted so far.
    pub fn written(&self) -> u64 {
        self.written
    }

    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        if self.reserved.is_none() && self.buf.len() + data.len() > UNRESERVED {
            self.reserved = Some(reserve(self.part_size).await?);
        }
        self.written += data.len() as u64;
        self.buf.extend_from_slice(data);
        while self.buf.len() >= self.part_size {
            let part = self.buf.split_to(self.part_size).freeze();
            let held = self.reserved.take();
            self.send_part(part, held).await?;
        }
        Ok(())
    }

    async fn ensure_multipart(&mut self) -> Result<String> {
        if let Some(id) = &self.upload_id {
            return Ok(id.clone());
        }
        let created =
            self.active.client.create_multipart_upload().bucket(&self.active.bucket).key(&self.key).send().await?;
        let id = created.upload_id().context("Object store did not return a multipart upload id")?.to_string();
        self.upload_id = Some(id.clone());
        Ok(id)
    }

    /// Send one part; `held` is its share of the budget, freed once it is stored.
    async fn send_part(&mut self, part: Bytes, held: Option<OwnedSemaphorePermit>) -> Result<()> {
        let upload_id = self.ensure_multipart().await?;
        while self.in_flight.len() >= MAX_IN_FLIGHT {
            self.collect_one().await?;
        }
        let number = self.next_part;
        self.next_part += 1;
        let (client, bucket, key) = (self.active.client.clone(), self.active.bucket.clone(), self.key.clone());
        self.in_flight.spawn(async move {
            let _held = held;
            let len = part.len() as i64;
            let out = client
                .upload_part()
                .bucket(bucket)
                .key(key)
                .upload_id(upload_id)
                .part_number(number)
                .content_length(len)
                .body(ByteStream::from(part))
                .send()
                .await
                .with_context(|| format!("UploadPart {number} failed"))?;
            let etag = out.e_tag().context("Object store did not return an ETag")?.to_string();
            Ok(CompletedPart::builder().e_tag(etag).part_number(number).build())
        });
        Ok(())
    }

    async fn collect_one(&mut self) -> Result<()> {
        if let Some(joined) = self.in_flight.join_next().await {
            let part = joined.context("upload task failed")??;
            self.parts.push(part);
        }
        Ok(())
    }

    /// Flush the tail and commit the object.
    pub async fn finish(mut self) -> Result<u64> {
        self.finished = true;
        let result = self.finish_inner().await;
        if result.is_err() {
            self.abort().await;
        }
        result
    }

    async fn finish_inner(&mut self) -> Result<u64> {
        let tail = std::mem::take(&mut self.buf).freeze();
        if self.upload_id.is_none() {
            self.active
                .client
                .put_object()
                .bucket(&self.active.bucket)
                .key(&self.key)
                .content_length(tail.len() as i64)
                .body(ByteStream::from(tail))
                .send()
                .await
                .with_context(|| format!("PutObject failed for {}", self.key))?;
            return Ok(self.written);
        }
        if !tail.is_empty() {
            let held = self.reserved.take();
            self.send_part(tail, held).await?;
        }
        while !self.in_flight.is_empty() {
            self.collect_one().await?;
        }
        let mut parts = std::mem::take(&mut self.parts);
        parts.sort_by_key(|p| p.part_number());
        if parts.is_empty() {
            bail!("multipart upload has no parts");
        }
        let upload_id = self.upload_id.clone().unwrap_or_default();
        self.active
            .client
            .complete_multipart_upload()
            .bucket(&self.active.bucket)
            .key(&self.key)
            .upload_id(upload_id)
            .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
            .send()
            .await
            .context("CompleteMultipartUpload failed")?;
        self.upload_id = None;
        Ok(self.written)
    }

    /// Give up: stop in-flight parts and abort the multipart upload, if any.
    pub async fn abort(&mut self) {
        self.finished = true;
        self.in_flight.abort_all();
        while self.in_flight.join_next().await.is_some() {}
        if let Some(id) = self.upload_id.take() {
            let _ = self
                .active
                .client
                .abort_multipart_upload()
                .bucket(&self.active.bucket)
                .key(&self.key)
                .upload_id(id)
                .send()
                .await;
        }
    }
}

impl Drop for UploadSink {
    fn drop(&mut self) {
        // A sink dropped mid-upload (the client hung up) must not leave parts billed forever.
        if !self.finished
            && let Some(id) = self.upload_id.take()
        {
            let (client, bucket, key) = (self.active.client.clone(), self.active.bucket.clone(), self.key.clone());
            self.in_flight.abort_all();
            tokio::spawn(async move {
                let _ = client.abort_multipart_upload().bucket(bucket).key(key).upload_id(id).send().await;
            });
        }
    }
}
