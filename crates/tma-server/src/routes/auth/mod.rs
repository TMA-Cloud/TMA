//! Sign-in, sign-up, sign-out, the profile and password change; Google sign-in
//! is in `google_flow`.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::header::SET_COOKIE;
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tma_core::api::{ChangePasswordRequest, LoginRequest, SignupRequest, User, UserEnvelope};

use super::JsonBody;
use crate::auth::{self, AuthUser, jwt, password};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::models::{mfa, sessions, users};
use crate::services::audit::Event;
use crate::services::limits;
use crate::state::AppState;
use crate::util::{is_email, normalize_email};

mod google_flow;

pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/signup", post(signup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/google/enabled", get(google_flow::google_enabled))
        .route("/google/login", get(google_flow::google_login))
        .route("/google/callback", get(google_flow::google_callback))
        .route("/google/mfa-verify", post(google_flow::google_mfa_verify))
}

pub fn authed_routes() -> Router<AppState> {
    Router::new()
        .route("/logout-all", post(logout_all))
        .route("/profile", get(profile))
        .route("/change-password", post(change_password))
}

pub(super) fn checked_email(raw: &str) -> Result<String, ApiError> {
    let raw = raw.trim();
    if !is_email(raw) {
        return Err(ApiError::validation("email", "Invalid email format"));
    }
    if raw.len() > 254 {
        return Err(ApiError::validation("email", "Email must not exceed 254 characters"));
    }
    normalize_email(raw).ok_or_else(|| ApiError::validation("email", "Invalid email format"))
}

/// Refuse an address another account uses, and audit the attempt as `event` on `resource`.
pub(super) async fn ensure_email_free(
    state: &AppState,
    ctx: &ReqCtx,
    email: &str,
    event: &str,
    resource: &str,
) -> ApiResult<()> {
    if users::by_email(&state.pool, email).await?.is_some() {
        state.audit.log(
            ctx,
            Event::new(event)
                .failure()
                .resource(resource, None)
                .meta(json!({ "email": email, "reason": "email_already_in_use" })),
        );
        return Err(ApiError::conflict("Email already in use"));
    }
    Ok(())
}

fn cookie_header(value: String) -> AppendHeaders<[(axum::http::HeaderName, String); 1]> {
    AppendHeaders([(SET_COOKIE, value)])
}

fn user_json(
    id: &str,
    email: &str,
    name: Option<String>,
    created: Option<chrono::DateTime<chrono::Utc>>,
    mfa: bool,
    account: Option<&users::Account>,
) -> User {
    let is_sub = account.is_some_and(|a| a.is_sub_user);
    User {
        id: id.into(),
        email: email.into(),
        name,
        token_version: None,
        created_at: created,
        mfa_enabled: mfa,
        is_sub_user: is_sub,
        permissions: if is_sub {
            account.map(|a| a.permissions.clone()).unwrap_or_default()
        } else {
            tma_core::permissions::all_keys()
        },
    }
}

async fn signup(
    State(state): State<AppState>,
    ctx: ReqCtx,
    JsonBody(body): JsonBody<SignupRequest>,
) -> ApiResult<Response> {
    state.limits.check(limits::AUTH, &format!("auth:{}:{}", ctx.ip.clone().unwrap_or_default(), body.email))?;
    if state.settings.get().await.signup_enabled == Some(false) {
        return Err(ApiError::forbidden("Signup is currently disabled"));
    }
    let email = checked_email(&body.email)?;
    password::check_new_password(&body.password, "Password").map_err(|m| ApiError::validation("password", m))?;
    let name = body.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if name.as_ref().is_some_and(|n| n.chars().count() > 100) {
        return Err(ApiError::validation("name", "Name must not exceed 100 characters"));
    }
    ensure_email_free(&state, &ctx, &email, "auth.login.failure", "auth").await?;
    let hash = password::hash(&body.password).await?;
    let user = users::create(&state, &email, &hash, name.as_deref()).await?;
    state.audit.log(
        &ctx,
        Event::new("auth.signup")
            .resource("user", Some(&user.id))
            .actor(&user.id, &user.id, "owner")
            .meta(json!({ "email": email, "method": "password" })),
    );
    tracing::info!(user_id = %user.id, "User signed up successfully");
    users::handle_first_user_setup(&state, &user.id).await?;
    let token = auth::start_session(&state, &user.id, &ctx, Some(1)).await?;
    let body = UserEnvelope {
        user: User {
            id: user.id,
            email: user.email,
            name: user.name,
            created_at: user.created_at,
            mfa_enabled: user.mfa_enabled.unwrap_or(false),
            ..Default::default()
        },
    };
    Ok((cookie_header(auth::session_cookie(&state, &token).await), Json(body)).into_response())
}

async fn login(State(state): State<AppState>, ctx: ReqCtx, JsonBody(body): JsonBody<LoginRequest>) -> Response {
    let ip = ctx.ip.clone().unwrap_or_default();
    let account_key = format!("login-account:{}", body.email.trim().to_lowercase());
    let ip_key = format!("login-ip:{ip}");
    for (spec, key) in [
        (limits::AUTH, format!("auth:{ip}:{}", body.email)),
        (limits::LOGIN_FAILURES_PER_IP, ip_key.clone()),
        (limits::LOGIN_FAILURES_PER_ACCOUNT, account_key.clone()),
    ] {
        if let Err(limited) = state.limits.check(spec, &key) {
            return limited.into_response();
        }
    }
    let response = match login_inner(&state, &ctx, body).await {
        Ok(response) => response,
        Err(err) => err.into_response(),
    };
    // Only failures count against the failure limiters, so a good sign-in costs nothing.
    if response.status().as_u16() >= 400 {
        state.limits.record_failure(limits::LOGIN_FAILURES_PER_IP, &ip_key);
        state.limits.record_failure(limits::LOGIN_FAILURES_PER_ACCOUNT, &account_key);
    }
    response
}

async fn login_inner(state: &AppState, ctx: &ReqCtx, body: LoginRequest) -> ApiResult<Response> {
    let email = checked_email(&body.email)?;
    if body.password.chars().count() > 128 {
        return Err(ApiError::validation("password", "Password must not exceed 128 characters"));
    }
    let user = users::by_email(&state.pool, &email).await?;
    // Always run bcrypt: skipping it for unknown emails lets timing reveal which accounts exist.
    let hash = match user.as_ref().and_then(|u| u.password.clone()) {
        Some(h) => h,
        None => password::dummy_hash().await,
    };
    let valid = password::verify(&body.password, &hash).await;
    let fail = |reason: &str| {
        state.audit.log(
            ctx,
            Event::new("auth.login.failure")
                .failure()
                .resource("auth", None)
                .meta(json!({ "email": email, "reason": reason })),
        );
    };
    let Some(user) = user.filter(|u| u.password.is_some()) else {
        fail("user_not_found");
        return Err(ApiError::unauthorized("Invalid credentials"));
    };
    if !valid {
        fail("invalid_password");
        return Err(ApiError::unauthorized("Invalid credentials"));
    }
    if mfa::state(&state.pool, &user.id).await?.is_some_and(|m| m.enabled()) {
        let Some(code) = body.mfa_code.filter(|c| !c.is_empty()) else {
            return Err(ApiError::bad_request("MFA code required"));
        };
        if !mfa::verify_code(&state.pool, &user.id, &code).await? {
            fail("invalid_mfa_code");
            return Err(ApiError::unauthorized("Invalid MFA code"));
        }
    }
    let account = users::account(state, &user.id).await?;
    let (owner, role) = match &account {
        Some(a) if a.is_sub_user => (a.owner_id.clone(), "sub_user"),
        _ => (user.id.clone(), "owner"),
    };
    state.audit.log(
        ctx,
        Event::new("auth.login")
            .resource("auth", None)
            .actor(&user.id, &owner, role)
            .meta(json!({ "email": email, "method": "password" })),
    );
    tracing::info!(user_id = %user.id, "User logged in successfully");
    let token = auth::start_session(state, &user.id, ctx, None).await?;
    let body = UserEnvelope {
        user: user_json(
            &user.id,
            &user.email,
            user.name,
            user.created_at,
            user.mfa_enabled.unwrap_or(false),
            account.as_ref(),
        ),
    };
    Ok((cookie_header(auth::session_cookie(state, &token).await), Json(body)).into_response())
}

async fn logout(State(state): State<AppState>, ctx: ReqCtx, headers: HeaderMap) -> Response {
    if let Some(claims) = auth::raw_token(&headers).and_then(|t| jwt::verify(&state.config.jwt_secret, &t)) {
        if let Some(sid) = &claims.sid {
            if let Err(err) = sessions::delete(&state, sid, &claims.id).await {
                tracing::warn!(error = %err, "Failed to revoke session on logout");
            }
            let _ = sessions::delete_heartbeat(&state.pool, &claims.id, sid).await;
        }
        let mut ctx = ctx.clone();
        ctx.user_id = Some(claims.id.clone());
        state.audit.log(&ctx, Event::new("auth.logout").resource("auth", claims.sid.as_deref()));
    }
    (cookie_header(jwt::clear_cookie("token")), Json(json!({ "message": "Logged out" }))).into_response()
}

async fn logout_all(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Response> {
    let version = users::invalidate_all_sessions(&state, &auth.user_id).await?;
    sessions::delete_all(&state, &auth.user_id).await?;
    sessions::delete_all_heartbeats(&state.pool, &auth.user_id).await?;
    state.audit.log(&ctx, Event::new("auth.logout_all").resource("auth", None));
    tracing::info!(user_id = %auth.user_id, version, "User logged out from all devices");
    Ok((
        cookie_header(jwt::clear_cookie("token")),
        Json(json!({ "message": "Successfully logged out from all devices", "sessionsInvalidated": true })),
    )
        .into_response())
}

async fn profile(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<User>> {
    let user = users::by_id(&state, &auth.user_id).await?.ok_or_else(|| ApiError::not_found("Not found"))?;
    Ok(Json(User {
        id: user.id,
        email: user.email,
        name: user.name,
        token_version: Some(user.token_version),
        created_at: user.created_at,
        mfa_enabled: user.mfa_enabled.unwrap_or(false),
        is_sub_user: auth.is_sub_user,
        permissions: if auth.is_sub_user { auth.permissions.clone() } else { tma_core::permissions::all_keys() },
    }))
}

const RECENT_AUTH_SECS: i64 = 600;

async fn change_password(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<ChangePasswordRequest>,
) -> ApiResult<Response> {
    state.limits.check(limits::AUTH, &format!("auth:{}:", ctx.ip.clone().unwrap_or_default()))?;
    if body.old_password.is_empty() || body.old_password.chars().count() > 128 {
        return Err(ApiError::validation("oldPassword", "Current password is required"));
    }
    password::check_new_password(&body.new_password, "New password")
        .map_err(|m| ApiError::validation("newPassword", m))?;
    if state.settings.get().await.allow_password_change != Some(true) {
        return Err(ApiError::forbidden("Password change is currently disabled by the administrator!!"));
    }
    let failed = |reason: &str| {
        state.audit.log(
            &ctx,
            Event::new("auth.password_change").failure().resource("auth", None).meta(json!({ "reason": reason })),
        )
    };
    // Re-authentication gate: a hijacked long-lived session cannot change the password.
    if let Some(sid) = &auth.session_id
        && !sessions::is_recent(&state.pool, sid, &auth.user_id, RECENT_AUTH_SECS).await?
    {
        failed("session_not_recent");
        return Err(ApiError::forbidden("For your security, please log in again before changing your password."));
    }
    if mfa::state(&state.pool, &auth.user_id).await?.is_some_and(|m| m.enabled()) {
        let Some(code) = body.mfa_code.as_deref().filter(|c| !c.is_empty()) else {
            return Err(ApiError::bad_request("MFA verification code is required to change your password."));
        };
        if !mfa::verify_code(&state.pool, &auth.user_id, code).await? {
            failed("invalid_mfa_code");
            return Err(ApiError::unauthorized("Invalid MFA code."));
        }
    }
    let user = users::with_password(&state.pool, &auth.user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("User not found!!"))?;
    let Some(hash) = user.password else {
        return Err(ApiError::bad_request("Password change is not available for this account!!"));
    };
    if !password::verify(&body.old_password, &hash).await {
        failed("invalid_current_password");
        return Err(ApiError::bad_request("Current password is incorrect!!"));
    }
    if body.old_password == body.new_password {
        return Err(ApiError::bad_request("New password must be different from the current password!!"));
    }
    users::set_password(&state, &auth.user_id, &password::hash(&body.new_password).await?).await?;
    let version = users::invalidate_all_sessions(&state, &auth.user_id).await?;
    sessions::delete_all(&state, &auth.user_id).await?;
    state.audit.log(
        &ctx,
        Event::new("auth.password_change").resource("auth", None).meta(json!({ "newTokenVersion": version })),
    );
    Ok(Json(json!({ "message": "Password changed successfully, Please log in again!" })).into_response())
}
