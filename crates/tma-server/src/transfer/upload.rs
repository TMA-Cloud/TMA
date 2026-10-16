//! Multipart uploads streamed straight into the bucket: each file part is
//! sniffed, encrypted under its own data key and multipart-uploaded as it
//! arrives, with no temp files. Stored objects are tracked by a guard that
//! queues their deletion unless the handler commits rows for them.

use std::collections::HashMap;

use axum::extract::Multipart;
use bytes::Bytes;

use crate::crypto::{Encryptor, plaintext_size_to_ciphertext_size};
use crate::error::ApiError;
use crate::models::files::crud::StreamedUpload;
use crate::services::cleanup;
use crate::state::AppState;
use crate::util::generate_id;

const SNIFF_BYTES: usize = 4100;

/// A file the server refused, with the ordinal of its part.
#[derive(Debug, Clone)]
pub struct PartFailure {
    pub index: usize,
    pub file_name: String,
    pub error: String,
}

/// Objects written by a request; deleted (via the worker) unless disarmed.
pub struct UploadedKeys {
    state: AppState,
    keys: Vec<String>,
}

impl UploadedKeys {
    fn new(state: AppState) -> Self {
        Self { state, keys: Vec::new() }
    }

    /// The handler stored rows for these keys; they are no longer orphans.
    pub fn keep(&mut self, keys: &[String]) {
        self.keys.retain(|k| !keys.contains(k));
    }

    pub fn keep_all(&mut self) {
        self.keys.clear();
    }
}

impl Drop for UploadedKeys {
    fn drop(&mut self) {
        if self.keys.is_empty() {
            return;
        }
        let keys = std::mem::take(&mut self.keys);
        let state = self.state.clone();
        tokio::spawn(async move {
            tracing::info!(count = keys.len(), "[StreamUpload] Cleaning up objects of a failed or abandoned upload");
            cleanup::enqueue_object_cleanup(&state, keys, "stream-upload-abandoned").await;
        });
    }
}

/// Everything a multipart upload carried.
pub struct UploadOutcome {
    pub fields: HashMap<String, Vec<String>>,
    pub uploads: Vec<StreamedUpload>,
    pub failures: Vec<PartFailure>,
    pub keys: UploadedKeys,
}

impl UploadOutcome {
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).and_then(|v| v.first()).map(String::as_str)
    }

    pub fn field_list(&self, name: &str) -> &[String] {
        self.fields.get(name).map(Vec::as_slice).unwrap_or(&[])
    }
}

fn failure_status(reason: &str) -> axum::http::StatusCode {
    use axum::http::StatusCode;
    if reason.contains("File too large") {
        StatusCode::PAYLOAD_TOO_LARGE
    } else if reason.starts_with("Storage is temporarily unavailable") {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::BAD_REQUEST
    }
}

/// Read the whole form, storing every `file`/`files` part. `single` stops at the
/// first refused file (one-file endpoints); bulk keeps going and reports each.
pub async fn receive(state: &AppState, mut form: Multipart, single: bool) -> Result<UploadOutcome, ApiError> {
    let settings = state.settings.get().await;
    let max_bytes = settings.max_upload_bytes() as u64;
    // Refuse before reading the body when no bucket is connected.
    state.storage.active().await?;
    let mut out = UploadOutcome {
        fields: HashMap::new(),
        uploads: Vec::new(),
        failures: Vec::new(),
        keys: UploadedKeys::new(state.clone()),
    };
    let mut index = 0usize;
    loop {
        let field = match form.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(err) => return Err(ApiError::bad_request(format!("Upload failed: {err}"))),
        };
        let name = field.name().unwrap_or_default().to_string();
        let Some(file_name) = field.file_name().map(String::from).filter(|n| !n.is_empty()) else {
            let value = field.text().await.map_err(|e| ApiError::bad_request(format!("Upload failed: {e}")))?;
            out.fields.entry(name).or_default().push(value);
            continue;
        };
        if name != "file" && name != "files" {
            continue;
        }
        let declared = field.content_type().map(String::from);
        let this_index = index;
        index += 1;
        match store_part(state, field, &file_name, declared, max_bytes, this_index).await {
            Ok(upload) => {
                out.keys.keys.push(upload.storage_name.clone());
                out.uploads.push(upload);
            }
            Err(reason) => {
                tracing::warn!(file = %file_name, %reason, "[StreamUpload] File refused");
                if single {
                    return Err(ApiError::new(failure_status(&reason), reason));
                }
                out.failures.push(PartFailure { index: this_index, file_name, error: reason });
            }
        }
    }
    Ok(out)
}

async fn store_part(
    state: &AppState,
    field: axum::extract::multipart::Field<'_>,
    file_name: &str,
    declared: Option<String>,
    max_bytes: u64,
    index: usize,
) -> Result<StreamedUpload, String> {
    use futures::TryStreamExt;
    let chunks = field.map_err(|e| format!("Upload failed: {e}"));
    store_stream(state, chunks, file_name, declared, max_bytes, index).await
}

/// Stream `chunks` into a new encrypted object; the shared core of every upload.
pub async fn store_stream<S>(
    state: &AppState,
    mut chunks: S,
    file_name: &str,
    declared: Option<String>,
    max_bytes: u64,
    index: usize,
) -> Result<StreamedUpload, String>
where
    S: futures::Stream<Item = Result<Bytes, String>> + Unpin,
{
    use futures::StreamExt;
    let id = generate_id();
    let storage_name = format!("{id}{}", tma_core::names::extname(file_name));
    let dek = state.keyring.new_dek().map_err(|e| e.to_string())?;
    let mut encryptor = Encryptor::new(&dek.dek).map_err(|e| e.to_string())?;
    let unavailable = |err: anyhow::Error| {
        tracing::error!(error = %format!("{err:#}"), "[StreamUpload] Upload failed");
        "Storage is temporarily unavailable. Please try again.".to_string()
    };
    let mut sink = state
        .storage
        .upload_sink(&storage_name, plaintext_size_to_ciphertext_size(max_bytes))
        .await
        .map_err(unavailable)?;
    let mut sniff = Vec::with_capacity(SNIFF_BYTES);
    let mut detected: Option<String> = None;
    let mut total = 0u64;
    let result: Result<(), String> = async {
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            total += chunk.len() as u64;
            if total > max_bytes {
                return Err("File too large".into());
            }
            if detected.is_none() && sniff.len() < SNIFF_BYTES {
                sniff.extend_from_slice(&chunk[..chunk.len().min(SNIFF_BYTES - sniff.len())]);
                if sniff.len() >= SNIFF_BYTES {
                    detected = sniff_mime(&sniff);
                }
            }
            for part in encryptor.push(&chunk).map_err(|e| e.to_string())? {
                sink.write(&part).await.map_err(unavailable)?;
            }
        }
        Ok(())
    }
    .await;
    if let Err(reason) = result {
        sink.abort().await;
        return Err(reason);
    }
    if detected.is_none() {
        detected = sniff_mime(&sniff);
    }
    for part in encryptor.finish().map_err(|e| e.to_string())? {
        sink.write(&part).await.map_err(unavailable)?;
    }
    sink.finish().await.map_err(unavailable)?;
    // The stored type comes from the content when it is recognisable, never just the client's word.
    let mime_type =
        detected.or(declared).filter(|m| !m.is_empty()).unwrap_or_else(|| "application/octet-stream".into());
    Ok(StreamedUpload {
        id,
        storage_name,
        name: file_name.to_string(),
        size: total as i64,
        mime_type,
        dek_wrapped: dek.wrapped,
        dek_kek_version: dek.kek_version,
        index,
    })
}

pub fn sniff_mime(head: &[u8]) -> Option<String> {
    if head.len() < 256 {
        return None;
    }
    infer::get(head).map(|t| t.mime_type().to_string())
}

/// The folder part of a browser relative path: "Trip/Videos/clip.mp4" -> ["Trip", "Videos"].
pub fn folder_segments(relative_path: &str, file_name: &str) -> Vec<String> {
    let normalized = relative_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.trim_start_matches('/').trim().split('/').filter(|p| !p.is_empty()).collect();
    let Some(last) = parts.last() else { return Vec::new() };
    let last_is_file = *last == file_name || last.contains('.');
    let folders = if last_is_file { &parts[..parts.len() - 1] } else { &parts[..] };
    folders.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments() {
        assert_eq!(folder_segments("Trip/Videos/clip.mp4", "clip.mp4"), vec!["Trip", "Videos"]);
        assert_eq!(folder_segments("/a\\b/", "x"), vec!["a", "b"]);
        assert!(folder_segments("", "x").is_empty());
    }
}
