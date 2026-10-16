//! Signing in with Google: the redirect to Google, its callback, and the
//! two-factor step that follows when the account has it on.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::header::{COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Redirect, Response};
use serde::Deserialize;
use serde_json::json;

use super::super::JsonBody;
use super::cookie_header;
use crate::auth::{self, google, jwt};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::models::{mfa, users};
use crate::services::audit::Event;
use crate::services::limits;
use crate::state::AppState;
use crate::util::normalize_email;

pub(super) async fn google_enabled(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "enabled": state.google.get(&state.pool, &state.keyring).await.is_some() }))
}

const OAUTH_COOKIE: &str = "oauth_flow";

pub(super) async fn google_login(State(state): State<AppState>, ctx: ReqCtx) -> Response {
    if let Err(l) = state.limits.check(limits::AUTH, &format!("auth:{}:", ctx.ip.clone().unwrap_or_default())) {
        return l.into_response();
    }
    let Some(config) = state.google.get(&state.pool, &state.keyring).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Google sign-in is turned off").into_response();
    };
    // state blocks login CSRF; PKCE binds the code to this browser.
    let flow_state =
        base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, crate::crypto::random_bytes::<24>());
    let (verifier, challenge) = google::pkce_pair();
    let cookie = jwt::cookie(OAUTH_COOKIE, &format!("{flow_state}.{verifier}"), 600, state.config.secure_cookies());
    (cookie_header(cookie), Redirect::to(&google::auth_url(&config, &flow_state, &challenge))).into_response()
}

#[derive(Deserialize)]
pub(super) struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

pub(super) async fn google_callback(
    State(state): State<AppState>,
    ctx: ReqCtx,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    match google_callback_inner(&state, &ctx, &headers, q).await {
        Ok(response) => response,
        Err(err) => {
            tracing::error!(error = %err, "Google OAuth authentication failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "Authentication failed").into_response()
        }
    }
}

async fn google_callback_inner(
    state: &AppState,
    ctx: &ReqCtx,
    headers: &HeaderMap,
    q: CallbackQuery,
) -> anyhow::Result<Response> {
    let Some(config) = state.google.get(&state.pool, &state.keyring).await else {
        return Ok((StatusCode::SERVICE_UNAVAILABLE, "Google sign-in is turned off").into_response());
    };
    let clear = jwt::clear_cookie(OAUTH_COOKIE);
    let flow = jwt::read_cookie(headers.get(COOKIE).and_then(|v| v.to_str().ok()), OAUTH_COOKIE);
    let verifier = flow.as_deref().and_then(|raw| raw.split_once('.')).and_then(|(expected, verifier)| {
        let returned = q.state.as_deref().unwrap_or("");
        crate::crypto::constant_time_eq(expected.as_bytes(), returned.as_bytes()).then(|| verifier.to_string())
    });
    let Some(verifier) = verifier.filter(|_| !q.state.as_deref().unwrap_or("").is_empty()) else {
        tracing::warn!("Google OAuth callback rejected: missing or mismatched state");
        return Ok((cookie_header(clear), Redirect::to("/?error=oauth_state")).into_response());
    };
    let Some(code) = q.code.filter(|c| !c.is_empty()) else {
        return Ok((StatusCode::BAD_REQUEST, "Missing code").into_response());
    };
    let identity = google::exchange(&state.http, &state.google, &config, &code, &verifier).await?;
    let email = identity.email.clone().unwrap_or_default();
    let user_id = match users::by_google_id(&state.pool, &identity.sub).await? {
        Some((id, _)) => id,
        None => {
            // Linking or creating by email trusts Google's claim to own the address.
            if identity.email_verified != Some(true) {
                return Ok((cookie_header(clear), Redirect::to("/?error=email_unverified")).into_response());
            }
            let normalized = normalize_email(&email).unwrap_or_else(|| email.to_lowercase());
            match users::by_email(&state.pool, &normalized).await? {
                Some(existing) => {
                    users::set_google_id(state, &existing.id, &identity.sub).await?;
                    existing.id
                }
                None => {
                    if state.settings.get().await.signup_enabled == Some(false) {
                        return Ok((cookie_header(clear), Redirect::to("/?error=signup_disabled")).into_response());
                    }
                    let user =
                        users::create_with_google(state, &identity.sub, &normalized, identity.name.as_deref()).await?;
                    state.audit.log(
                        ctx,
                        Event::new("auth.signup")
                            .resource("user", Some(&user.id))
                            .actor(&user.id, &user.id, "owner")
                            .meta(json!({ "email": normalized, "method": "google" })),
                    );
                    users::handle_first_user_setup(state, &user.id).await?;
                    user.id
                }
            }
        }
    };
    let account = users::account(state, &user_id).await?;
    let owner = account.as_ref().map(|a| a.owner_id.clone()).unwrap_or_else(|| user_id.clone());
    let role = if account.as_ref().is_some_and(|a| a.is_sub_user) { "sub_user" } else { "owner" };
    state.audit.log(
        ctx,
        Event::new("auth.login")
            .resource("auth", None)
            .actor(&user_id, &owner, role)
            .meta(json!({ "email": email, "method": "google" })),
    );
    if mfa::state(&state.pool, &user_id).await?.is_some_and(|m| m.enabled()) {
        // A short-lived signed cookie carries the pending state; never the email in the URL.
        let now = chrono::Utc::now().timestamp();
        let pending = jwt::sign_value(
            &state.config.jwt_secret,
            &json!({ "userId": user_id, "purpose": "mfa_pending", "iat": now, "exp": now + 300 }),
        )?;
        let cookie = jwt::cookie("mfa_pending", &pending, 300, state.config.secure_cookies());
        return Ok((AppendHeaders([(SET_COOKIE, clear), (SET_COOKIE, cookie)]), Redirect::to("/?mfa_required=true"))
            .into_response());
    }
    let token = auth::start_session(state, &user_id, ctx, None).await?;
    let session = auth::session_cookie(state, &token).await;
    Ok((AppendHeaders([(SET_COOKIE, clear), (SET_COOKIE, session)]), Redirect::to("/")).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MfaVerifyBody {
    mfa_code: Option<String>,
}

pub(super) async fn google_mfa_verify(
    State(state): State<AppState>,
    ctx: ReqCtx,
    headers: HeaderMap,
    JsonBody(body): JsonBody<MfaVerifyBody>,
) -> ApiResult<Response> {
    state.limits.check(limits::MFA, &format!("mfa:{}:", ctx.ip.clone().unwrap_or_default()))?;
    let Some(code) = body.mfa_code.filter(|c| !c.is_empty()) else {
        return Err(ApiError::bad_request("MFA code required"));
    };
    let pending = jwt::read_cookie(headers.get(COOKIE).and_then(|v| v.to_str().ok()), "mfa_pending")
        .ok_or_else(|| ApiError::unauthorized("MFA session expired or missing. Please sign in again."))?;
    let claims = jwt::verify_value(&state.config.jwt_secret, &pending, true)
        .ok_or_else(|| ApiError::unauthorized("MFA session expired. Please sign in again."))?;
    let user_id = match (claims.get("purpose").and_then(|v| v.as_str()), claims.get("userId").and_then(|v| v.as_str()))
    {
        (Some("mfa_pending"), Some(id)) => id.to_string(),
        _ => return Err(ApiError::unauthorized("Invalid MFA session")),
    };
    if !mfa::verify_code(&state.pool, &user_id, &code).await? {
        state.audit.log(
            &ctx,
            Event::new("auth.login.failure")
                .failure()
                .resource("auth", None)
                .meta(json!({ "reason": "invalid_mfa_code" })),
        );
        return Err(ApiError::unauthorized("Invalid MFA code"));
    }
    let token = auth::start_session(&state, &user_id, &ctx, None).await?;
    let session = auth::session_cookie(&state, &token).await;
    Ok((
        AppendHeaders([(SET_COOKIE, jwt::clear_cookie("mfa_pending")), (SET_COOKIE, session)]),
        Json(json!({ "success": true })),
    )
        .into_response())
}
