//! Fixed-window rate limits kept in memory per process, as express-rate-limit
//! did. Limiters that count only failures let a successful sign-in cost nothing.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use dashmap::DashMap;
use serde_json::json;

#[derive(Clone, Copy)]
pub struct LimitSpec {
    pub window: Duration,
    pub max: u32,
    pub message: &'static str,
    /// Count only responses with status >= 400.
    pub failures_only: bool,
}

const MIN: Duration = Duration::from_secs(60);

pub const AUTH: LimitSpec = LimitSpec {
    window: Duration::from_secs(900),
    max: 25,
    message: "Too many requests, please try again later",
    failures_only: false,
};
pub const LOGIN_FAILURES_PER_IP: LimitSpec = LimitSpec {
    window: Duration::from_secs(900),
    max: 100,
    message: "Too many failed sign-in attempts from this network, please try again later",
    failures_only: true,
};
pub const LOGIN_FAILURES_PER_ACCOUNT: LimitSpec = LimitSpec {
    window: Duration::from_secs(900),
    max: 20,
    message: "Too many failed sign-in attempts for this account, please try again later",
    failures_only: true,
};
pub const MFA: LimitSpec = LimitSpec {
    window: MIN,
    max: 5,
    message: "Too many MFA verification attempts, please try again in a minute",
    failures_only: false,
};
pub const BACKUP_CODES: LimitSpec = LimitSpec {
    window: Duration::from_secs(600),
    max: 3,
    message: "Too many backup code regeneration attempts, please try again later",
    failures_only: false,
};
pub const STORAGE_CONFIG: LimitSpec = LimitSpec {
    window: Duration::from_secs(900),
    max: 20,
    message: "Too many storage connection attempts, please try again later",
    failures_only: false,
};
pub const GOOGLE_CONFIG: LimitSpec = LimitSpec {
    window: Duration::from_secs(900),
    max: 20,
    message: "Too many Google sign-in setting changes, please try again later",
    failures_only: false,
};
pub const API: LimitSpec = LimitSpec {
    window: Duration::from_secs(900),
    max: 10_000,
    message: "Too many requests, please try again later",
    failures_only: false,
};
pub const UPLOAD: LimitSpec = LimitSpec {
    window: Duration::from_secs(1800),
    max: 20_000,
    message: "Too many uploads, please try again later",
    failures_only: false,
};

#[derive(Clone, Default)]
pub struct RateLimits {
    windows: Arc<DashMap<String, (Instant, u32)>>,
    sse: Arc<DashMap<String, u32>>,
}

/// A refused request: 429 with RateLimit headers.
pub struct Limited {
    spec: LimitSpec,
    reset: Duration,
}

impl IntoResponse for Limited {
    fn into_response(self) -> Response {
        let mut headers = HeaderMap::new();
        let secs = self.reset.as_secs().max(1);
        if let Ok(v) = HeaderValue::from_str(&self.spec.max.to_string()) {
            headers.insert("ratelimit-limit", v);
        }
        headers.insert("ratelimit-remaining", HeaderValue::from_static("0"));
        if let Ok(v) = HeaderValue::from_str(&secs.to_string()) {
            headers.insert("ratelimit-reset", v.clone());
            headers.insert("retry-after", v);
        }
        (
            StatusCode::TOO_MANY_REQUESTS,
            headers,
            axum::Json(json!({ "error": self.spec.message, "message": self.spec.message })),
        )
            .into_response()
    }
}

impl From<Limited> for crate::error::ApiError {
    fn from(l: Limited) -> Self {
        crate::error::ApiError::too_many(l.spec.message).with("error", l.spec.message)
    }
}

impl RateLimits {
    fn bucket(&self, spec: &LimitSpec, key: &str) -> String {
        format!("{}:{}:{key}", spec.window.as_secs(), spec.max)
    }

    /// Refuse when the key has used up its window; otherwise count this request
    /// (unless the limiter counts failures only).
    pub fn check(&self, spec: LimitSpec, key: &str) -> Result<(), Limited> {
        let now = Instant::now();
        let mut entry = self.windows.entry(self.bucket(&spec, key)).or_insert((now, 0));
        if now.duration_since(entry.0) >= spec.window {
            *entry = (now, 0);
        }
        if entry.1 >= spec.max {
            return Err(Limited { spec, reset: spec.window.saturating_sub(now.duration_since(entry.0)) });
        }
        if !spec.failures_only {
            entry.1 += 1;
        }
        Ok(())
    }

    /// Count a failed request against a failures-only limiter.
    pub fn record_failure(&self, spec: LimitSpec, key: &str) {
        let now = Instant::now();
        let mut entry = self.windows.entry(self.bucket(&spec, key)).or_insert((now, 0));
        if now.duration_since(entry.0) >= spec.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
    }

    /// Hold an SSE slot for a user; `None` when they already have too many streams open.
    pub fn acquire_sse(&self, user_id: &str, max: u32) -> Option<SseSlot> {
        let mut count = self.sse.entry(user_id.to_string()).or_insert(0);
        if *count >= max {
            return None;
        }
        *count += 1;
        Some(SseSlot { limits: self.clone(), user_id: user_id.to_string() })
    }

    /// Drop expired windows; run periodically.
    pub fn prune(&self) {
        let now = Instant::now();
        self.windows.retain(|key, (start, _)| {
            let secs: u64 = key.split(':').next().and_then(|s| s.parse().ok()).unwrap_or(3600);
            now.duration_since(*start) < Duration::from_secs(secs)
        });
    }
}

/// Released when the SSE stream ends.
pub struct SseSlot {
    limits: RateLimits,
    user_id: String,
}

impl Drop for SseSlot {
    fn drop(&mut self) {
        if let Some(mut count) = self.limits.sse.get_mut(&self.user_id) {
            *count = count.saturating_sub(1);
        }
        self.limits.sse.remove_if(&self.user_id, |_, c| *c == 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_and_failures() {
        let limits = RateLimits::default();
        let spec = LimitSpec { window: Duration::from_secs(60), max: 2, message: "x", failures_only: false };
        assert!(limits.check(spec, "k").is_ok());
        assert!(limits.check(spec, "k").is_ok());
        assert!(limits.check(spec, "k").is_err());
        let failures = LimitSpec { failures_only: true, ..spec };
        assert!(limits.check(failures, "f").is_ok());
        limits.record_failure(failures, "f");
        limits.record_failure(failures, "f");
        assert!(limits.check(failures, "f").is_err());
        let slot = limits.acquire_sse("u", 1);
        assert!(slot.is_some());
        assert!(limits.acquire_sse("u", 1).is_none());
        drop(slot);
        assert!(limits.acquire_sse("u", 1).is_some());
    }
}
