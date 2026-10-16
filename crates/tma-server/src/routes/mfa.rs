//! Two-factor enrolment, removal and backup codes.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tma_core::api::{BackupCodes, CountResponse, MfaEnabled, MfaSetup, MfaStatus};

use super::JsonBody;
use crate::auth::{AuthUser, totp};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::models::{mfa, users};
use crate::services::limits;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/mfa/status", get(status))
        .route("/mfa/setup", post(setup))
        .route("/mfa/verify", post(verify))
        .route("/mfa/disable", post(disable))
        .route("/mfa/backup-codes/regenerate", post(regenerate))
        .route("/mfa/backup-codes/count", get(count))
}

#[derive(Deserialize)]
struct CodeBody {
    code: Option<String>,
}

fn mfa_key(ctx: &ReqCtx, auth: &AuthUser) -> String {
    format!("mfa:{}:{}", ctx.ip.clone().unwrap_or_default(), auth.user_id)
}

async fn status(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<MfaStatus>> {
    let st = mfa::state(&state.pool, &auth.user_id).await?.ok_or_else(|| ApiError::not_found("User not found"))?;
    Ok(Json(MfaStatus { enabled: st.enabled() }))
}

async fn setup(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<MfaSetup>> {
    let user = users::by_id(&state, &auth.user_id).await?.ok_or_else(|| ApiError::not_found("User not found"))?;
    if mfa::state(&state.pool, &auth.user_id).await?.is_some_and(|m| m.enabled()) {
        return Err(ApiError::bad_request("MFA is already enabled"));
    }
    let secret = totp::generate_secret();
    let qr_code = totp::qr_data_url(&totp::provisioning_uri(&secret, &user.email))
        .map_err(|e| ApiError::internal_msg("Failed to setup MFA", e))?;
    // Stored but not enabled until the user proves they can produce a code.
    mfa::set_secret(&state, &auth.user_id, &secret, false).await?;
    Ok(Json(MfaSetup { secret, qr_code }))
}

async fn verify(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<CodeBody>,
) -> ApiResult<Json<MfaEnabled>> {
    state.limits.check(limits::MFA, &mfa_key(&ctx, &auth))?;
    let code =
        body.code.filter(|c| !c.is_empty()).ok_or_else(|| ApiError::bad_request("Verification code required"))?;
    let st = mfa::state(&state.pool, &auth.user_id).await?.ok_or_else(|| ApiError::not_found("User not found"))?;
    let Some(secret) = st.mfa_secret.clone() else {
        return Err(ApiError::bad_request("MFA not set up. Please set up MFA first."));
    };
    // Enrolment only: re-posting a valid code must not append another set of backup codes.
    if st.enabled() {
        return Err(ApiError::bad_request("MFA is already enabled"));
    }
    if !mfa::verify_totp(&state.pool, &auth.user_id, &secret, None, &code).await? {
        return Err(ApiError::bad_request("Invalid verification code"));
    }
    mfa::enable(&state, &auth.user_id).await?;
    let backup_codes = mfa::replace_backup_codes(&state.pool, &auth.user_id, 10).await?;
    tracing::info!(user_id = %auth.user_id, "MFA verified and enabled");
    Ok(Json(MfaEnabled { message: "MFA enabled successfully".into(), backup_codes, should_prompt_sessions: true }))
}

async fn disable(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<CodeBody>,
) -> ApiResult<Json<serde_json::Value>> {
    state.limits.check(limits::MFA, &mfa_key(&ctx, &auth))?;
    if !mfa::state(&state.pool, &auth.user_id).await?.is_some_and(|m| m.enabled()) {
        return Err(ApiError::bad_request("MFA is not enabled"));
    }
    let code = body
        .code
        .filter(|c| !c.is_empty())
        .ok_or_else(|| ApiError::bad_request("Verification code required to disable MFA"))?;
    if !mfa::verify_code(&state.pool, &auth.user_id, &code).await? {
        return Err(ApiError::bad_request("Invalid verification code"));
    }
    mfa::disable(&state, &auth.user_id).await?;
    tracing::info!(user_id = %auth.user_id, "MFA disabled");
    Ok(Json(json!({ "message": "MFA disabled successfully", "shouldPromptSessions": true })))
}

fn describe_wait(ms: i64) -> String {
    let secs = (ms.max(0) + 999) / 1000;
    let (minutes, rest) = (secs / 60, secs % 60);
    let plural = |n: i64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    if minutes > 0 {
        format!("{} and {}", plural(minutes, "minute"), plural(rest, "second"))
    } else {
        plural(rest, "second")
    }
}

async fn regenerate(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Json<BackupCodes>> {
    state.limits.check(
        limits::BACKUP_CODES,
        &format!("backup-codes:{}:{}", ctx.ip.clone().unwrap_or_default(), auth.user_id),
    )?;
    if !mfa::state(&state.pool, &auth.user_id).await?.is_some_and(|m| m.enabled()) {
        return Err(ApiError::bad_request("MFA is not enabled"));
    }
    if let Err(remaining) = mfa::claim_regeneration(&state.pool, &auth.user_id).await? {
        return Err(ApiError::too_many(format!(
            "Please wait {} before regenerating backup codes again",
            describe_wait(remaining)
        ))
        .with("retryAfterMs", remaining));
    }
    let backup_codes = mfa::replace_backup_codes(&state.pool, &auth.user_id, 10).await?;
    Ok(Json(BackupCodes { backup_codes }))
}

async fn count(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<CountResponse>> {
    if !mfa::state(&state.pool, &auth.user_id).await?.is_some_and(|m| m.enabled()) {
        return Err(ApiError::bad_request("MFA is not enabled"));
    }
    Ok(Json(CountResponse { count: mfa::remaining_codes(&state.pool, &auth.user_id).await? }))
}
