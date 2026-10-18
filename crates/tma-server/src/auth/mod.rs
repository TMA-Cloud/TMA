//! Who is calling. The auth middleware verifies the token, its version and its
//! session, resolves the account the identity acts under, and slides the
//! session forward by re-issuing the cookie while the user is active.

pub mod jwt;
pub mod password;
pub mod totp;

use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tma_core::Permission;

use crate::error::ApiError;
use crate::middleware::ReqCtx;
use crate::models::{sessions, users};
use crate::state::AppState;

/// The authenticated caller.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub session_id: Option<String>,
    /// The account whose files and quota this identity acts on.
    pub owner_id: String,
    pub permissions: Vec<String>,
    pub is_sub_user: bool,
}

impl AuthUser {
    pub fn can(&self, permission: Permission) -> bool {
        !self.is_sub_user || self.permissions.iter().any(|p| p == permission.key())
    }

    /// The role recorded in the audit trail.
    pub fn role(&self) -> &'static str {
        if self.is_sub_user { "sub_user" } else { "owner" }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts.extensions.get::<AuthUser>().cloned().ok_or_else(|| ApiError::unauthorized("No token provided"))
    }
}

/// The raw token from the `token` cookie or an `Authorization: Bearer` header.
pub fn raw_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let cookie = headers.get(COOKIE).and_then(|v| v.to_str().ok());
    if let Some(t) = jwt::read_cookie(cookie, "token").filter(|t| !t.is_empty()) {
        return Some(t);
    }
    let auth = headers.get(AUTHORIZATION)?.to_str().ok()?;
    auth.split_whitespace().nth(1).map(String::from)
}

/// Seconds a session survives without activity, as the first user set it.
pub async fn idle_secs(state: &AppState) -> i64 {
    state.settings.get().await.activity().session_idle_days as i64 * 86_400
}

/// Set-Cookie for a fresh session token.
pub async fn session_cookie(state: &AppState, token: &str) -> String {
    jwt::cookie("token", token, idle_secs(state).await, state.config.secure_cookies())
}

/// Create a session row and the token bound to it.
pub async fn start_session(
    state: &AppState,
    user_id: &str,
    ctx: &ReqCtx,
    version: Option<i32>,
) -> anyhow::Result<String> {
    let version = match version {
        Some(v) => v,
        None => users::token_version(state, user_id).await?.unwrap_or(1),
    };
    let sid = sessions::create(&state.pool, user_id, version, ctx.user_agent.as_deref(), ctx.ip.as_deref()).await?;
    jwt::issue(&state.config.jwt_secret, user_id, version, Some(&sid), idle_secs(state).await)
}

fn reject(message: &str) -> Response {
    ApiError::unauthorized(message).into_response()
}

/// Require a valid session on every request it wraps.
pub async fn require_auth(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let Some(token) = raw_token(req.headers()) else { return reject("No token provided") };
    let Some(claims) = jwt::verify(&state.config.jwt_secret, &token) else {
        tracing::warn!("Invalid token provided");
        return reject("Invalid token");
    };
    let (version, account) = tokio::join!(users::token_version(&state, &claims.id), users::account(&state, &claims.id));
    let Ok(Some(current_version)) = version else {
        tracing::warn!(user_id = %claims.id, "Token validation failed: user not found");
        return reject("Invalid token");
    };
    let token_version = claims.v.unwrap_or(1);
    if token_version != current_version {
        return reject("Session expired. Please login again.");
    }
    let ip = req.extensions().get::<ReqCtx>().and_then(|c| c.ip.clone());
    if let Some(sid) = &claims.sid {
        // Revoking the session the token belongs to is allowed; later requests then fail.
        let revoking_own = req.method() == Method::DELETE
            && req.uri().path().trim_end_matches('/').ends_with(&format!("/sessions/{sid}"));
        if !revoking_own {
            let idle = idle_secs(&state).await;
            match sessions::is_valid(&state, sid, &claims.id, token_version, idle).await {
                Ok(true) => {}
                Ok(false) => return reject("Session has been revoked. Please login again."),
                Err(err) => return ApiError::internal(err).into_response(),
            }
            let (pool, sid, ip) = (state.pool.clone(), sid.clone(), ip.clone());
            tokio::spawn(async move {
                if let Err(err) = sessions::touch(&pool, &sid, ip.as_deref()).await {
                    tracing::debug!(error = %err, "Failed to update session activity");
                }
            });
        }
    }
    let Ok(Some(account)) = account else { return reject("Invalid token") };
    let auth = AuthUser {
        user_id: claims.id.clone(),
        session_id: claims.sid.clone(),
        owner_id: account.owner_id,
        permissions: account.permissions,
        is_sub_user: account.is_sub_user,
    };
    if let Some(ctx) = req.extensions_mut().get_mut::<ReqCtx>() {
        ctx.user_id = Some(auth.user_id.clone());
        ctx.owner_id = Some(auth.owner_id.clone());
        ctx.role = Some(auth.role());
    }
    req.extensions_mut().insert(auth);
    let mut response = next.run(req).await;
    renew_if_needed(&state, &claims, &mut response).await;
    response
}

/// Re-issue the token once less than 80% of the idle window remains, so an
/// active session slides forward instead of expiring on a fixed schedule.
async fn renew_if_needed(state: &AppState, claims: &jwt::Claims, response: &mut Response) {
    let idle = idle_secs(state).await;
    let remaining = claims.exp - chrono::Utc::now().timestamp();
    if remaining > idle * 8 / 10 {
        return;
    }
    // A handler that already set or cleared the token (logout) has the last word.
    let touched =
        response.headers().get_all(SET_COOKIE).iter().any(|v| v.to_str().is_ok_and(|s| s.starts_with("token=")));
    if touched {
        return;
    }
    match jwt::issue(&state.config.jwt_secret, &claims.id, claims.v.unwrap_or(1), claims.sid.as_deref(), idle) {
        Ok(token) => {
            if let Ok(value) = HeaderValue::from_str(&session_cookie(state, &token).await) {
                response.headers_mut().append(SET_COOKIE, value);
            }
        }
        Err(err) => tracing::warn!(error = %err, user_id = %claims.id, "Failed to renew auth token"),
    }
}

/// 403 unless the caller holds `permission`; owners always pass.
pub async fn require(state: &AppState, auth: &AuthUser, ctx: &ReqCtx, permission: Permission) -> Result<(), ApiError> {
    if auth.can(permission) {
        return Ok(());
    }
    tracing::warn!(user_id = %auth.user_id, permission = permission.key(), path = %ctx.path, "Sub-user attempted an action without the required permission");
    state.audit.log(
        ctx,
        crate::services::audit::Event::new("account.permission_denied")
            .failure()
            .resource("account", None)
            .meta(serde_json::json!({ "permission": permission.key(), "method": ctx.method, "path": ctx.path })),
    );
    Err(ApiError::forbidden(format!(
        "You do not have permission to do that. Ask the account owner to enable \"{}\".",
        permission.label()
    )))
}

/// 403 for sub-users: only account owners manage sub-users.
pub fn require_owner(state: &AppState, auth: &AuthUser, ctx: &ReqCtx) -> Result<(), ApiError> {
    if !auth.is_sub_user {
        return Ok(());
    }
    state.audit.log(
        ctx,
        crate::services::audit::Event::new("account.owner_action_denied")
            .failure()
            .resource("account", None)
            .meta(serde_json::json!({ "method": ctx.method, "path": ctx.path, "reason": "sub_user" })),
    );
    Err(ApiError::forbidden("Only the account owner can perform this action."))
}

/// 403 unless the caller is the first user; the denial is audited.
pub async fn require_first_user(
    state: &AppState,
    auth: &AuthUser,
    ctx: &ReqCtx,
    action: &str,
    message: &str,
) -> Result<(), ApiError> {
    if crate::settings::is_first_user(&state.pool, &state.settings, &auth.user_id).await? {
        return Ok(());
    }
    let audit_action = if action.starts_with("get_") || action.starts_with("read_") {
        "admin.settings.read"
    } else {
        "admin.settings.update"
    };
    state.audit.log(
        ctx,
        crate::services::audit::Event::new(audit_action)
            .failure()
            .resource("settings", None)
            .meta(serde_json::json!({ "action": action, "reason": "unauthorized" })),
    );
    tracing::warn!(user_id = %auth.user_id, action, "Unauthorized admin attempt");
    Err(ApiError::forbidden(message))
}
