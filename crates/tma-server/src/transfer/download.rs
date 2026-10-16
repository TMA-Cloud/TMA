//! Serving stored files: decrypted on the fly, honouring single-range requests
//! by fetching and opening only the ciphertext segments the range touches.

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;

use crate::crypto::{
    Decryptor, HEADER_LENGTH, RangePlan, ciphertext_size_to_plaintext_size, plaintext_size_to_ciphertext_size,
};
use crate::error::ApiError;
use crate::models::files::crud::StoredFile;
use crate::state::AppState;
use crate::util::{RangeSpec, content_disposition, parse_range};

/// A body from a decrypting stream; the bound pins the stream's error type for inference.
pub(crate) fn stream_body<S>(stream: S) -> Body
where
    S: futures::Stream<Item = anyhow::Result<bytes::Bytes>> + Send + 'static,
{
    Body::from_stream(stream)
}

/// A storage key is a bare object name; anything path-like is refused.
pub fn is_valid_key(key: &str) -> bool {
    !key.is_empty() && !key.contains("..") && !key.contains('/') && !key.contains('\\')
}

/// Extensions a browser could run or render dangerously; always served as attachments.
pub fn requires_download(name: &str) -> bool {
    const EXTS: &[&str] = &[
        "exe", "dll", "bat", "cmd", "com", "pif", "scr", "vbs", "js", "jse", "ws", "wsf", "wsh", "ps1", "psm1", "msi",
        "msp", "jar", "app", "deb", "rpm", "dmg", "pkg", "sh", "bash", "csh", "ksh", "command", "action", "html",
        "htm", "svg",
    ];
    let ext = tma_core::names::extension_of(name);
    EXTS.contains(&ext.as_str())
}

/// Plaintext size of a stored file, from its row or (for old rows) the object.
async fn plaintext_size(state: &AppState, file: &StoredFile, key: &str) -> Result<u64, ApiError> {
    if let Some(size) = file.size.filter(|s| *s >= 0) {
        return Ok(size as u64);
    }
    let stat = state.storage.stat(key).await?.ok_or_else(|| ApiError::not_found("File not found in storage"))?;
    ciphertext_size_to_plaintext_size(stat.size).map_err(ApiError::internal)
}

/// Stream a stored file. `inline` asks for an inline disposition (images, the document server).
pub async fn serve(
    state: &AppState,
    file: &StoredFile,
    range: Option<&str>,
    inline: bool,
) -> Result<Response, ApiError> {
    let key = file.path.clone().ok_or_else(|| ApiError::not_found("File path not found"))?;
    if !is_valid_key(&key) {
        return Err(ApiError::bad_request("Invalid file path"));
    }
    let size = plaintext_size(state, file, &key).await?;
    let ikm =
        state.keyring.resolve_ikm(file.dek_wrapped.as_deref(), file.dek_kek_version).map_err(ApiError::internal)?;
    let mime = file.mime_type.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "application/octet-stream".into());
    let disposition = if inline { "inline" } else { "attachment" };

    let mut builder = Response::builder()
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")),
        )
        .header(header::ACCEPT_RANGES, "bytes")
        // Uploaded HTML or SVG opened directly runs no script on this origin.
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        );
    if let Ok(value) = HeaderValue::from_str(&content_disposition(disposition, &file.name)) {
        builder = builder.header(header::CONTENT_DISPOSITION, value);
    }

    match parse_range(range, size) {
        Some(RangeSpec::Unsatisfiable) => {
            Ok((StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{size}"))])
                .into_response())
        }
        Some(RangeSpec::Satisfiable { start, end }) => {
            let plan = RangePlan::new(size, start, end);
            let head = state.storage.get_bytes(&key, Some((0, HEADER_LENGTH as u64 - 1))).await?;
            let mut decryptor = plan.decryptor(&ikm, &head).map_err(ApiError::internal)?;
            let mut source = state.storage.get(&key, Some((plan.ciphertext_start, plan.ciphertext_end))).await?;
            let body = async_stream::try_stream! {
                while let Some(chunk) = source.next().await {
                    for part in decryptor.push(&chunk?)? {
                        yield part;
                    }
                    if decryptor.is_done() {
                        break;
                    }
                }
            };
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                .header(header::CONTENT_LENGTH, end - start + 1)
                .body(stream_body(body))
                .map_err(ApiError::internal)
        }
        None => {
            let mut source = state.storage.get(&key, None).await?;
            let expected = plaintext_size_to_ciphertext_size(size);
            let body = async_stream::try_stream! {
                let mut decryptor = Decryptor::new(ikm);
                let mut seen = 0u64;
                while let Some(chunk) = source.next().await {
                    let chunk = chunk?;
                    seen += chunk.len() as u64;
                    for part in decryptor.push(&chunk)? {
                        yield part;
                    }
                }
                if seen != expected {
                    tracing::warn!(seen, expected, "Stored object size differs from the recorded size");
                }
                yield decryptor.finish()?;
            };
            builder
                .status(StatusCode::OK)
                .header(header::CONTENT_LENGTH, size)
                .body(stream_body(body))
                .map_err(ApiError::internal)
        }
    }
}
