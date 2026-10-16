//! The web app: static files from the trunk build, with every unknown path
//! falling back to index.html so client-side routes deep-link.

use axum::Json;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

/// `/settings` and `/shared` are app routes; only `/api` and `/s` belong to the server.
fn is_backend_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/") || path == "/s" || path.starts_with("/s/")
}

/// Trunk names bundles `<name>-<hash>.<ext>`, so they never change in place.
fn is_hashed_asset(path: &str) -> bool {
    let file = path.rsplit('/').next().unwrap_or("");
    let stem = file.split('.').next().unwrap_or("");
    let stem = stem.strip_suffix("_bg").unwrap_or(stem);
    stem.rsplit_once('-').is_some_and(|(_, hash)| hash.len() >= 16 && hash.chars().all(|c| c.is_ascii_hexdigit()))
}

pub async fn serve(State(state): State<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    if is_backend_path(&path) {
        return (StatusCode::NOT_FOUND, Json(json!({ "message": "Not found" }))).into_response();
    }
    let Some(dist) = state.config.web_dist_dir.clone() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "message": "Frontend not available. Build the web app.", "error": "FRONTEND_NOT_BUILT" })),
        )
            .into_response();
    };
    let index = dist.join("index.html");
    let service = ServeDir::new(&dist).precompressed_br().precompressed_gzip().fallback(ServeFile::new(index));
    let mut response = match service.oneshot(req).await {
        Ok(response) => response.map(Body::new),
        Err(err) => match err {},
    };
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    let cache = if !is_html && is_hashed_asset(&path) { "public, max-age=31536000, immutable" } else { "no-cache" };
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert!(is_backend_path("/api/files"));
        assert!(is_backend_path("/s/abc"));
        assert!(!is_backend_path("/settings"));
        assert!(!is_backend_path("/shared"));
        assert!(is_hashed_asset("/tma-cloud-web-1a2b3c4d5e6f7a8b.js"));
        assert!(is_hashed_asset("/tma-cloud-web-1a2b3c4d5e6f7a8b_bg.wasm"));
        assert!(!is_hashed_asset("/favicon.ico"));
        assert!(!is_hashed_asset("/index.html"));
    }
}
