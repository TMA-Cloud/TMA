//! Security headers and the Content Security Policy. Server-rendered pages get
//! a per-request nonce; the web app's static inline scripts are allowed by hash.

use axum::extract::{Request, State};
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine as _;

use crate::state::AppState;

/// The nonce a server-rendered page puts on its inline scripts.
#[derive(Debug, Clone)]
pub struct CspNonce(pub String);

pub async fn security_headers(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let nonce = base64::engine::general_purpose::STANDARD.encode(crate::crypto::random_bytes::<16>());
    req.extensions_mut().insert(CspNonce(nonce.clone()));
    let onlyoffice = state.settings.get().await.onlyoffice_origin();
    let mut response = next.run(req).await;

    // 'wasm-unsafe-eval' lets the browser compile the app's WebAssembly; it does not allow eval().
    let mut script_src = format!("script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'");
    for hash in state.spa_script_hashes.current().iter() {
        script_src.push(' ');
        script_src.push_str(hash);
    }
    let mut connect_src = String::from("connect-src 'self'");
    let mut frame_src = String::from("frame-src 'self'");
    if let Some(origin) = &onlyoffice {
        for part in [&mut script_src, &mut connect_src, &mut frame_src] {
            part.push(' ');
            part.push_str(origin);
        }
    }
    let csp = [
        "default-src 'self'",
        &script_src,
        "object-src 'none'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        &connect_src,
        &frame_src,
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ]
    .join("; ");

    let headers = response.headers_mut();
    let set = |headers: &mut axum::http::HeaderMap, name: &'static str, value: &str| {
        if let Ok(v) = HeaderValue::from_str(value) {
            headers.insert(name, v);
        }
    };
    set(headers, "x-content-type-options", "nosniff");
    set(headers, "x-frame-options", "DENY");
    // The legacy XSS auditor can be abused; the CSP replaces it.
    set(headers, "x-xss-protection", "0");
    set(headers, "referrer-policy", "strict-origin-when-cross-origin");
    set(headers, "permissions-policy", "camera=(), microphone=(), geolocation=()");
    set(headers, "content-security-policy", &csp);
    response
}

/// The web app's inline-script hashes, re-read when its index.html changes so
/// a rebuilt web app works without restarting the server.
pub struct SpaHashes {
    index: Option<std::path::PathBuf>,
    cached: std::sync::Mutex<(Option<std::time::SystemTime>, std::sync::Arc<Vec<String>>)>,
}

impl SpaHashes {
    pub fn new(dist: Option<&std::path::Path>) -> Self {
        let this = Self {
            index: dist.map(|d| d.join("index.html")),
            cached: std::sync::Mutex::new((None, std::sync::Arc::default())),
        };
        this.current();
        this
    }

    pub fn current(&self) -> std::sync::Arc<Vec<String>> {
        let Some(index) = &self.index else { return std::sync::Arc::default() };
        let modified = std::fs::metadata(index).and_then(|m| m.modified()).ok();
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if cached.0 != modified || modified.is_none() {
            let hashes = std::fs::read_to_string(index).map(|html| inline_script_hashes(&html)).unwrap_or_default();
            *cached = (modified, std::sync::Arc::new(hashes));
        }
        cached.1.clone()
    }
}

/// CSP hashes for the inline `<script>` blocks of the built web app.
pub fn inline_script_hashes(index_html: &str) -> Vec<String> {
    let mut hashes = Vec::new();
    let mut rest = index_html;
    while let Some(start) = rest.find("<script") {
        let after = &rest[start..];
        let Some(tag_end) = after.find('>') else { break };
        let tag = &after[..tag_end];
        let body_start = &after[tag_end + 1..];
        let Some(close) = body_start.find("</script>") else { break };
        if !tag.contains(" src=") {
            let body = &body_start[..close];
            let digest = crate::crypto::sha256(body.as_bytes());
            hashes.push(format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(digest)));
        }
        rest = &body_start[close + 9..];
    }
    hashes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_inline_only() {
        let html = r#"<script src="/a.js"></script><script type="module">init()</script>"#;
        let hashes = inline_script_hashes(html);
        assert_eq!(hashes.len(), 1);
        assert!(hashes[0].starts_with("'sha256-"));
    }
}
