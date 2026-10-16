//! Health, Prometheus metrics, the public signup flag and version checks.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use tma_core::api::{PublicSignupStatus, Versions};
use tokio::sync::Mutex;

use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::state::AppState;

const VERSIONS_URL: &str = "https://tma-cloud.github.io/updates/versions.json";
/// Releases are rare; without this every user's update check refetches the file.
const LATEST_TTL: Duration = Duration::from_secs(600);

fn started() -> Instant {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    *STARTED.get_or_init(Instant::now)
}

/// Pin the uptime origin at startup rather than on the first health check.
pub fn mark_started() {
    started();
}

pub async fn health() -> Json<Value> {
    Json(
        json!({ "status": "ok", "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "uptime": started().elapsed().as_secs_f64() }),
    )
}

pub async fn metrics(State(state): State<AppState>, ctx: ReqCtx) -> Response {
    let allowed = ctx.ip.as_ref().is_some_and(|ip| state.config.metrics_allowed_ips.iter().any(|a| a == ip));
    if !allowed {
        tracing::warn!(ip = ?ctx.ip, "Unauthorized metrics access attempt");
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], state.metrics.render()).into_response()
}

pub fn public_routes() -> Router<AppState> {
    Router::new().route("/signup-status", get(public_signup_status))
}

async fn public_signup_status(State(state): State<AppState>) -> Json<PublicSignupStatus> {
    Json(PublicSignupStatus { signup_enabled: state.settings.get().await.signup_enabled != Some(false) })
}

pub fn version_routes() -> Router<AppState> {
    Router::new().route("/", get(current)).route("/latest", get(latest))
}

/// One build serves the API, the web app and the desktop app, so they share a version.
async fn current() -> Json<Versions> {
    let version = Some(env!("CARGO_PKG_VERSION").to_string());
    Json(Versions { frontend: version.clone(), backend: version.clone(), desktop: version, ..Default::default() })
}

async fn latest(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
    let mut cached = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    if let Some((_, body)) = cached.as_ref().filter(|(at, _)| at.elapsed() < LATEST_TTL) {
        return Ok(Json(body.clone()));
    }
    let response = state.http.get(VERSIONS_URL).timeout(Duration::from_secs(10)).send().await.map_err(|err| {
        tracing::error!(error = %err, "Error fetching latest versions");
        if err.is_timeout() {
            ApiError::new(StatusCode::GATEWAY_TIMEOUT, "Request timeout while fetching versions")
        } else {
            ApiError::internal_msg("Failed to fetch latest versions", err)
        }
    })?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("GitHub returned status {}", response.status().as_u16()),
        ));
    }
    let versions: Value =
        response.json().await.map_err(|err| ApiError::internal_msg("Failed to parse versions data", err))?;
    let pick = |key: &str| versions.get(key).and_then(Value::as_str).unwrap_or("unknown").to_string();
    let body = json!({ "frontend": pick("frontend"), "backend": pick("backend"), "electron": pick("electron"), "desktop": pick("desktop") });
    *cached = Some((Instant::now(), body.clone()));
    Ok(Json(body))
}
