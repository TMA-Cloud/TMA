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

/// Whether `ip` is on the metrics allow-list, comparing addresses rather than text.
/// Loopback matches loopback in either family: the server answers on IPv6 too, so
/// a local scrape of localhost may arrive as ::1 where the list says 127.0.0.1.
fn metrics_allowed(ip: &str, allowed: &[String]) -> bool {
    let Ok(ip) = ip.parse::<std::net::IpAddr>().map(|ip| ip.to_canonical()) else { return false };
    allowed
        .iter()
        .filter_map(|a| a.parse::<std::net::IpAddr>().ok())
        .map(|a| a.to_canonical())
        .any(|a| a == ip || (a.is_loopback() && ip.is_loopback()))
}

pub async fn metrics(State(state): State<AppState>, ctx: ReqCtx) -> Response {
    let allowed = ctx.ip.as_deref().is_some_and(|ip| metrics_allowed(ip, &state.config.metrics_allowed_ips));
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
    Json(Versions { server: version.clone(), web: version.clone(), desktop: version })
}

async fn latest(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
    let mut cached = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    if let Some((_, body)) = cached.as_ref().filter(|(at, _)| at.elapsed() < LATEST_TTL) {
        return Ok(Json(body.clone()));
    }
    let response =
        state.http.get(&state.config.versions_url).timeout(Duration::from_secs(10)).send().await.map_err(|err| {
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
    let body = json!({ "server": pick("server"), "web": pick("web"), "desktop": pick("desktop") });
    *cached = Some((Instant::now(), body.clone()));
    Ok(Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_allow_list_compares_addresses() {
        let list = vec!["127.0.0.1".to_string(), "10.0.0.5".to_string()];
        assert!(metrics_allowed("127.0.0.1", &list));
        assert!(metrics_allowed("::1", &list), "a localhost scrape over IPv6");
        assert!(metrics_allowed("::ffff:10.0.0.5", &list), "an IPv4 client on the dual-stack socket");
        assert!(!metrics_allowed("10.0.0.6", &list));
        assert!(!metrics_allowed("not an address", &list));
        assert!(metrics_allowed("::1", &["::1".to_string()]));
    }
}
