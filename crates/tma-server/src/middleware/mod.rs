//! Request-wide middleware, outermost first: request context and access log,
//! share-domain isolation, desktop-only mode, security headers, CSRF.

mod guards;
mod headers;

pub use guards::{csrf, desktop_only, share_domain};
pub use headers::{CspNonce, SpaHashes, security_headers};

use std::net::{IpAddr, SocketAddr};
use std::time::Instant;

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

use crate::state::AppState;

/// Facts about the request every handler and the audit log need.
#[derive(Debug, Clone, Default)]
pub struct ReqCtx {
    pub request_id: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub forwarded_proto: Option<String>,
    pub user_id: Option<String>,
    pub owner_id: Option<String>,
    pub role: Option<&'static str>,
}

impl<S: Send + Sync> FromRequestParts<S> for ReqCtx {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(parts.extensions.get::<ReqCtx>().cloned().unwrap_or_default())
    }
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(String::from)
}

/// The client's id is echoed into a header and every log line, so only a safe shape is kept.
fn request_id(headers: &HeaderMap) -> String {
    header(headers, "x-request-id")
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string())
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// The client address: the socket peer, then forwarded hops walked from the
/// right while each address handing it on is a trusted proxy.
pub fn client_ip(peer: Option<IpAddr>, headers: &HeaderMap, trusted: &[ipnet::IpNet]) -> Option<IpAddr> {
    let mut addr = canonical(peer?);
    if trusted.is_empty() {
        return Some(addr);
    }
    let forwarded = header(headers, "x-forwarded-for").unwrap_or_default();
    for hop in forwarded.split(',').map(str::trim).rev().filter(|h| !h.is_empty()) {
        if !trusted.iter().any(|net| net.contains(&addr)) {
            break;
        }
        match hop.parse::<IpAddr>() {
            Ok(ip) => addr = canonical(ip),
            Err(_) => break,
        }
    }
    Some(addr)
}

/// Whether forwarded headers from this peer may be believed.
pub fn peer_is_trusted(peer: Option<IpAddr>, trusted: &[ipnet::IpNet]) -> bool {
    peer.map(canonical).is_some_and(|ip| trusted.iter().any(|n| n.contains(&ip)))
}

/// Build the request context, stamp `X-Request-ID`, and log the outcome.
pub async fn context(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let started = Instant::now();
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    let headers = req.headers();
    let trusted = peer_is_trusted(peer, &state.trusted_proxies);
    let ctx = ReqCtx {
        request_id: request_id(headers),
        ip: client_ip(peer, headers, &state.trusted_proxies).map(|ip| ip.to_string()),
        user_agent: header(headers, "user-agent"),
        method: req.method().to_string(),
        path: req.uri().path().to_string(),
        host: if trusted { header(headers, "x-forwarded-host") } else { None }
            .or_else(|| header(headers, "host"))
            .map(|h| h.split(',').next().unwrap_or("").trim().to_string()),
        forwarded_proto: if trusted {
            header(headers, "x-forwarded-proto").map(|p| p.split(',').next().unwrap_or("").trim().to_string())
        } else {
            None
        },
        ..Default::default()
    };
    let request_id = ctx.request_id.clone();
    let (method, path) = (ctx.method.clone(), ctx.path.clone());
    req.extensions_mut().insert(ctx);
    let mut response = next.run(req).await;
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    let status = response.status().as_u16();
    let quiet = path == "/health"
        || path == "/favicon.ico"
        || path.starts_with("/assets/")
        || path.ends_with(".wasm")
        || path.ends_with(".js");
    if !quiet {
        let ms = started.elapsed().as_millis() as u64;
        if status >= 500 {
            tracing::error!(%request_id, %method, %path, status, ms, "{method} {path} {status}");
        } else if status >= 400 {
            tracing::warn!(%request_id, %method, %path, status, ms, "{method} {path} {status}");
        } else {
            tracing::info!(%request_id, %method, %path, status, ms, "{method} {path} {status}");
        }
    }
    state.metrics.http_request(status);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_hops() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4, 10.0.0.2"));
        let trusted: Vec<ipnet::IpNet> = vec!["10.0.0.0/8".parse().unwrap()];
        let peer = Some("10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(peer, &headers, &trusted), Some("1.2.3.4".parse().unwrap()));
        assert_eq!(client_ip(peer, &headers, &[]), Some("10.0.0.1".parse().unwrap()));
        let outside = Some("8.8.8.8".parse().unwrap());
        assert_eq!(client_ip(outside, &headers, &trusted), Some("8.8.8.8".parse().unwrap()));
    }
}
