//! Uploads (streamed from disk on desktop, from memory on the web) and, on
//! desktop, downloads to a file, both with progress and cancellation.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tma_core::api::{BulkUploadResponse, FileItem};

use crate::error::{ApiError, ApiResult};
use crate::http::Client;

/// Shared counters a transfer updates and the UI reads.
#[derive(Debug, Default)]
pub struct Progress {
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub cancelled: AtomicBool,
}

impl Progress {
    pub fn new(total: u64) -> Arc<Self> {
        Arc::new(Self { total: AtomicU64::new(total), ..Default::default() })
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn fraction(&self) -> f32 {
        let total = self.total.load(Ordering::Relaxed);
        if total == 0 { 0.0 } else { (self.done.load(Ordering::Relaxed) as f64 / total as f64).min(1.0) as f32 }
    }
}

/// Where an upload's bytes come from.
#[derive(Debug, Clone)]
pub enum Source {
    Bytes(bytes::Bytes),
    #[cfg(not(target_arch = "wasm32"))]
    Path(std::path::PathBuf),
}

/// One file to upload.
#[derive(Debug, Clone)]
pub struct UploadFile {
    pub name: String,
    pub size: u64,
    pub source: Source,
    /// Last-modified time in Unix milliseconds, kept as the file's date.
    pub modified_ms: Option<i64>,
    /// Folder path inside an uploaded folder ("Photos/2026"), created on the server.
    pub relative_dir: Option<String>,
}

/// Where uploads go.
#[derive(Debug, Clone, Default)]
pub struct UploadOptions {
    pub parent_id: Option<String>,
}

fn mime_for(name: &str) -> String {
    mime_guess::from_path(name).first_raw().unwrap_or("application/octet-stream").to_string()
}

#[cfg(not(target_arch = "wasm32"))]
async fn file_part(file: &UploadFile, progress: Arc<Progress>) -> ApiResult<reqwest::multipart::Part> {
    use futures::StreamExt;
    let part = match &file.source {
        Source::Bytes(bytes) => {
            progress.done.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            reqwest::multipart::Part::bytes(bytes.to_vec())
        }
        Source::Path(path) => {
            let handle = tokio::fs::File::open(path)
                .await
                .map_err(|e| ApiError::local(format!("Cannot read {}: {e}", path.display())))?;
            let stream = futures::stream::unfold((handle, progress), |(mut handle, progress)| async move {
                use tokio::io::AsyncReadExt;
                if progress.is_cancelled() {
                    return Some((Err(std::io::Error::other("Upload cancelled")), (handle, progress)));
                }
                let mut buf = vec![0u8; 256 * 1024];
                match handle.read(&mut buf).await {
                    Ok(0) => None,
                    Ok(n) => {
                        buf.truncate(n);
                        progress.done.fetch_add(n as u64, Ordering::Relaxed);
                        Some((Ok(bytes::Bytes::from(buf)), (handle, progress)))
                    }
                    Err(err) => Some((Err(err), (handle, progress))),
                }
            })
            .boxed();
            reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), file.size)
        }
    };
    part.file_name(file.name.clone()).mime_str(&mime_for(&file.name)).map_err(ApiError::network)
}

#[cfg(target_arch = "wasm32")]
async fn file_part(file: &UploadFile, progress: Arc<Progress>) -> ApiResult<reqwest::multipart::Part> {
    let Source::Bytes(bytes) = &file.source;
    let part = reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(file.name.clone());
    // fetch reports no upload progress; the bar fills when the request completes.
    let _ = progress;
    part.mime_str(&mime_for(&file.name)).map_err(ApiError::network)
}

impl Client {
    /// Upload one file (into a folder path when `relative_dir` is set) and return its row.
    pub async fn upload(
        &self,
        file: &UploadFile,
        options: &UploadOptions,
        progress: Arc<Progress>,
    ) -> ApiResult<FileItem> {
        let mut form = reqwest::multipart::Form::new();
        if let Some(parent) = &options.parent_id {
            form = form.text("parentId", parent.clone());
        }
        let relative = match &file.relative_dir {
            Some(dir) if !dir.is_empty() => format!("{}/{}", dir.trim_matches('/'), file.name),
            _ => file.name.clone(),
        };
        form = form.text("relativePaths", relative).text("clientIds", "0");
        if let Some(ms) = file.modified_ms {
            form = form.text("lastModifiedTimes", ms.to_string());
        }
        form = form.part("files", file_part(file, progress.clone()).await?);
        let response: BulkUploadResponse =
            self.json(self.request(reqwest::Method::POST, "/api/files/upload/bulk").multipart(form)).await?;
        #[cfg(target_arch = "wasm32")]
        progress.done.store(file.size, Ordering::Relaxed);
        if let Some(item) = response.files.into_iter().next() {
            return Ok(item);
        }
        let reason = response
            .failed
            .and_then(|f| f.into_iter().next())
            .map(|f| f.error)
            .unwrap_or_else(|| "Upload failed".into());
        Err(ApiError::local(reason))
    }

    /// Replace a file's contents (desktop edits, and Replace when an upload's name is taken).
    pub async fn replace(&self, id: &str, file: &UploadFile, progress: Arc<Progress>) -> ApiResult<FileItem> {
        self.replace_from(id, file, None, progress).await
    }

    /// Replace a file's contents only if it is still at content version `base`;
    /// otherwise the server answers 409 (`ApiError::is_conflict`) and keeps its copy.
    pub async fn replace_from(
        &self,
        id: &str,
        file: &UploadFile,
        base: Option<i64>,
        progress: Arc<Progress>,
    ) -> ApiResult<FileItem> {
        let mut form = reqwest::multipart::Form::new();
        if let Some(ms) = file.modified_ms {
            form = form.text("lastModifiedTimes", ms.to_string());
        }
        if let Some(base) = base {
            form = form.text("baseVersion", base.to_string());
        }
        form = form.part("file", file_part(file, progress).await?);
        let path = format!("/api/files/{}/replace", crate::http::enc(id));
        self.json(self.request(reqwest::Method::POST, &path).multipart(form)).await
    }

    /// Hand a file's bytes to `sink` as they arrive, without writing them anywhere first.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn download_with(
        &self,
        id: &str,
        mut sink: impl FnMut(&[u8]) -> Result<(), String> + Send,
    ) -> ApiResult<()> {
        use futures::StreamExt;
        let response = self
            .send(self.request(reqwest::Method::GET, &format!("/api/files/{}/download", crate::http::enc(id))))
            .await?;
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            sink(&chunk.map_err(ApiError::network)?).map_err(ApiError::local)?;
        }
        Ok(())
    }

    /// Stream a download to `dest`.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn download_to(&self, id: &str, dest: &std::path::Path, progress: Arc<Progress>) -> ApiResult<()> {
        let response = self
            .send(self.request(reqwest::Method::GET, &format!("/api/files/{}/download", crate::http::enc(id))))
            .await?;
        stream_to(response, dest, progress).await
    }

    /// Stream several items as one ZIP to `dest`.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn download_bulk_to(
        &self,
        ids: &[String],
        dest: &std::path::Path,
        progress: Arc<Progress>,
    ) -> ApiResult<()> {
        let request =
            self.request(reqwest::Method::POST, "/api/files/download/bulk").json(&serde_json::json!({ "ids": ids }));
        stream_to(self.send(request).await?, dest, progress).await
    }

    /// A one-minute ticket the browser posts to `bulk_download_form_url`, so its own
    /// download manager streams the ZIP instead of the page holding it in memory.
    pub async fn bulk_download_ticket(&self, ids: &[String]) -> ApiResult<String> {
        let value: serde_json::Value =
            self.post("/api/files/download/bulk/ticket", &serde_json::json!({ "ids": ids })).await?;
        value
            .get("ticket")
            .and_then(serde_json::Value::as_str)
            .map(String::from)
            .ok_or_else(|| ApiError::local("The server did not return a download ticket"))
    }

    pub fn bulk_download_form_url(&self) -> String {
        self.url("/api/files/download/bulk/form")
    }
}

/// Write a response body to `dest` through a `.part` file renamed once complete.
#[cfg(not(target_arch = "wasm32"))]
async fn stream_to(response: reqwest::Response, dest: &std::path::Path, progress: Arc<Progress>) -> ApiResult<()> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    if let Some(len) = response.content_length() {
        progress.total.store(len, Ordering::Relaxed);
    }
    let mut part_name = dest.as_os_str().to_owned();
    part_name.push(".part");
    let part = std::path::PathBuf::from(part_name);
    let mut out = tokio::fs::File::create(&part)
        .await
        .map_err(|e| ApiError::local(format!("Cannot write {}: {e}", part.display())))?;
    let mut body = response.bytes_stream();
    let result: ApiResult<()> = async {
        while let Some(chunk) = body.next().await {
            if progress.is_cancelled() {
                return Err(ApiError::local("Download cancelled"));
            }
            let chunk = chunk.map_err(ApiError::network)?;
            out.write_all(&chunk).await.map_err(|e| ApiError::local(format!("Cannot write file: {e}")))?;
            progress.done.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
        out.flush().await.map_err(|e| ApiError::local(format!("Cannot write file: {e}")))
    }
    .await;
    drop(out);
    match result {
        Ok(()) => tokio::fs::rename(&part, dest)
            .await
            .map_err(|e| ApiError::local(format!("Cannot save {}: {e}", dest.display()))),
        Err(err) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(err)
        }
    }
}
