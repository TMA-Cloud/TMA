//! Streaming an unknown-length body into the bucket: one PutObject when it fits
//! in a part, otherwise a multipart upload with a few parts in flight, so the
//! server never holds more than a handful of parts in memory.

use anyhow::{Context, Result, bail};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use bytes::{Bytes, BytesMut};
use tokio::task::JoinSet;

use super::Active;

const MAX_IN_FLIGHT: usize = 3;

pub struct UploadSink {
    active: Active,
    key: String,
    part_size: usize,
    buf: BytesMut,
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
            buf: BytesMut::with_capacity(part_size.min(8 * 1024 * 1024)),
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
        self.written += data.len() as u64;
        self.buf.extend_from_slice(data);
        while self.buf.len() >= self.part_size {
            let part = self.buf.split_to(self.part_size).freeze();
            self.send_part(part).await?;
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

    async fn send_part(&mut self, part: Bytes) -> Result<()> {
        let upload_id = self.ensure_multipart().await?;
        while self.in_flight.len() >= MAX_IN_FLIGHT {
            self.collect_one().await?;
        }
        let number = self.next_part;
        self.next_part += 1;
        let (client, bucket, key) = (self.active.client.clone(), self.active.bucket.clone(), self.key.clone());
        self.in_flight.spawn(async move {
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
            self.send_part(tail).await?;
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
