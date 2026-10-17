//! Guards that refuse a request before it reaches a handler.

use axum::Json;
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use serde_json::json;

use super::ReqCtx;
use crate::state::AppState;

/// CSRF defence in depth: a state-changing request must carry a custom header,
/// which browsers never attach cross-origin without a preflight we would deny.
pub async fn csrf(req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let headers = req.headers();
    let xhr = headers.get("x-requested-with").is_some_and(|v| v == "XMLHttpRequest");
    let desktop = headers.contains_key(tma_core::DESKTOP_HEADER_NAME);
    if safe || xhr || desktop {
        return next.run(req).await;
    }
    (StatusCode::FORBIDDEN, Json(json!({ "message": "Forbidden: missing CSRF header" }))).into_response()
}

/// On the share domain only share links and health checks are served.
pub async fn share_domain(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let Some(share_host) = state.settings.get().await.share_base_host() else { return next.run(req).await };
    let host = req.extensions().get::<ReqCtx>().and_then(|c| c.host.clone()).unwrap_or_default();
    if !host.eq_ignore_ascii_case(&share_host) {
        return next.run(req).await;
    }
    let path = req.uri().path();
    if path.starts_with("/s/") || path == "/health" || path == "/metrics" {
        return next.run(req).await;
    }
    tracing::warn!(path, share_domain = %share_host, "Blocked access to main app route on share domain");
    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

const DESKTOP_ONLY_PAGE: &str = r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Desktop app only</title>
<style>
:root{color-scheme:light dark;--bg:#edece8;--card:#f7f6f3;--text:#2b2a26;--muted:rgba(43,42,38,.7);--accent:#0866cc;--edge:rgba(43,42,38,.17)}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b19;--card:#232320;--text:#f5f4f1;--muted:rgba(240,239,233,.62);--accent:#0a84ff;--edge:rgba(132,130,120,.34)}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
.card{background:var(--card);border:1px solid var(--edge);border-radius:18px;padding:32px 28px;max-width:420px}
h1{margin:0 0 8px;font-size:20px}p{margin:0;color:var(--muted);line-height:1.55;font-size:14px}
.badge{display:inline-block;margin-bottom:14px;color:var(--accent);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
</style></head><body><main class="card"><div class="badge">Desktop app only</div>
<h1>Access restricted to the desktop app</h1>
<p>This TMA Cloud instance only accepts the TMA Cloud desktop app. Open it there to sign in.</p></main></body></html>"#;

/// When the first user limits the instance to the desktop app, refuse everything
/// else except share links, health checks and the OnlyOffice server's own calls.
pub async fn desktop_only(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if state.settings.get().await.desktop_only != Some(true) {
        return next.run(req).await;
    }
    let path = req.uri().path();
    let exempt = path.starts_with("/s/")
        || path == "/health"
        || path == "/metrics"
        || path == "/api/onlyoffice/callback"
        || path.starts_with("/api/onlyoffice/file/")
        || path.starts_with("/api/onlyoffice/open/");
    let has_header =
        req.headers().get(tma_core::DESKTOP_HEADER_NAME).is_some_and(|v| v == tma_core::DESKTOP_HEADER_VALUE);
    if exempt || has_header {
        return next.run(req).await;
    }
    tracing::warn!(path, "Blocked non-desktop client request due to desktop-only access setting");
    let wants_html = !path.starts_with("/api")
        && req.headers().get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html"));
    if wants_html {
        return (StatusCode::FORBIDDEN, Html(DESKTOP_ONLY_PAGE)).into_response();
    }
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "message": "This instance is configured for desktop app access only.", "error": "DESKTOP_ONLY_ACCESS" })),
    )
        .into_response()
}
