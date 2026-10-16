//! The storage bucket and the Google sign-in client: both are verified against
//! the live service before saving, and both secrets are sealed at rest.

use axum::Json;
use axum::extract::State;
use serde_json::json;
use tma_core::api::{
    GoogleAuthInput, GoogleAuthSummary, StorageSettingsInput, StorageSettingsSummary, StorageStatus, StorageTestResult,
};

use crate::auth::{AuthUser, google, require_first_user};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::routes::JsonBody;
use crate::services::audit::Event;
use crate::services::limits;
use crate::settings::is_first_user;
use crate::state::AppState;
use crate::storage::{config as storage_config, probe};

/// Whether storage is ready, for every signed-in user (drives the setup banner).
pub async fn storage_status(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<StorageStatus>> {
    let can_configure = is_first_user(&state.pool, &state.settings, &auth.user_id).await?;
    Ok(Json(StorageStatus { configured: state.storage.is_configured().await, can_configure }))
}

pub async fn storage_config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
) -> ApiResult<Json<StorageSettingsSummary>> {
    require_first_user(&state, &auth, &ctx, "read_storage_config", "Only the first user can view storage").await?;
    Ok(Json(storage_config::summary(&state.pool).await?))
}

async fn candidate(
    state: &AppState,
    input: &StorageSettingsInput,
) -> ApiResult<(Option<storage_config::StorageConfig>, storage_config::StorageConfig, Vec<String>)> {
    // A secret that no longer decrypts (lost key) must not block entering fresh credentials.
    let current = storage_config::load(&state.pool, &state.keyring).await.unwrap_or_else(|err| {
        tracing::error!(error = %err, "[Storage] Saved storage secret could not be decrypted");
        None
    });
    let next = storage_config::normalize_settings(input, current.as_ref())?;
    let samples = storage_config::sample_keys(&state.pool, 5).await?;
    Ok((current, next, samples))
}

fn probe_error(err: probe::ProbeError) -> ApiError {
    ApiError::new(axum::http::StatusCode::UNPROCESSABLE_ENTITY, err.message)
        .code("STORAGE_PROBE_FAILED")
        .with("step", err.step)
}

pub async fn test_storage_config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(input): JsonBody<StorageSettingsInput>,
) -> ApiResult<Json<StorageTestResult>> {
    state.limits.check(limits::STORAGE_CONFIG, &format!("storage-config:{}", auth.user_id))?;
    require_first_user(&state, &auth, &ctx, "update_storage_config", "Only the first user can configure storage")
        .await?;
    let (_, config, samples) = candidate(&state, &input).await?;
    let checks = probe::probe(&config, &samples).await.map_err(probe_error)?;
    Ok(Json(StorageTestResult { ok: true, checks }))
}

pub async fn save_storage_config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(input): JsonBody<StorageSettingsInput>,
) -> ApiResult<Json<StorageSettingsSummary>> {
    state.limits.check(limits::STORAGE_CONFIG, &format!("storage-config:{}", auth.user_id))?;
    require_first_user(&state, &auth, &ctx, "update_storage_config", "Only the first user can configure storage")
        .await?;
    let (current, config, samples) = candidate(&state, &input).await?;
    let failure = |message: &str, step: Option<&str>| {
        state.audit.log(
            &ctx,
            Event::new("admin.settings.update")
                .failure()
                .resource("settings", None)
                .error(message)
                .meta(json!({ "action": "update_storage_config", "step": step })),
        );
    };
    // Nothing unverified is ever stored.
    if let Err(err) = probe::probe(&config, &samples).await {
        failure(&err.message, Some(err.step));
        return Err(probe_error(err));
    }
    let version = storage_config::save(&state.pool, &state.keyring, &config, &auth.user_id, input.expected_version)
        .await
        .inspect_err(|e| failure(&e.to_string(), None))?;
    state.storage_changed().await;
    let target_changed = current.as_ref().is_some_and(|c| c.endpoint != config.endpoint || c.bucket != config.bucket);
    state.audit.log(
        &ctx,
        Event::new("admin.settings.update").resource("settings", None).meta(json!({
            "setting": "storage_config", "provider": config.provider, "endpoint": config.endpoint, "bucket": config.bucket,
            "region": config.region, "targetChanged": target_changed,
            "credentialsChanged": current.as_ref().map(|c| c.access_key_id != config.access_key_id).unwrap_or(true), "version": version,
        })),
    );
    Ok(Json(storage_config::summary(&state.pool).await?))
}

pub async fn google_config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
) -> ApiResult<Json<GoogleAuthSummary>> {
    require_first_user(&state, &auth, &ctx, "read_google_auth_config", "Only the first user can view Google sign-in")
        .await?;
    Ok(Json(google::summary(&state.pool).await?))
}

pub async fn save_google_config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(input): JsonBody<GoogleAuthInput>,
) -> ApiResult<Json<GoogleAuthSummary>> {
    state.limits.check(limits::GOOGLE_CONFIG, &format!("google-auth-config:{}", auth.user_id))?;
    require_first_user(
        &state,
        &auth,
        &ctx,
        "update_google_auth_config",
        "Only the first user can configure Google sign-in",
    )
    .await?;
    let current = google::load(&state.pool, &state.keyring).await.unwrap_or(None);
    let config = google::normalize(&input, current.as_ref())?;
    if let Err((status, message)) = google::probe(&state.http, &config).await {
        state.audit.log(
            &ctx,
            Event::new("admin.settings.update")
                .failure()
                .resource("settings", None)
                .error(&message)
                .meta(json!({ "action": "update_google_auth_config" })),
        );
        return Err(ApiError::new(
            axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
            message,
        ));
    }
    let version =
        google::save(&state.pool, &state.keyring, Some(&config), &auth.user_id, input.expected_version).await?;
    state.google.invalidate().await;
    state.settings_changed().await;
    state.audit.log(
        &ctx,
        Event::new("admin.settings.update").resource("settings", None).meta(json!({
            "setting": "google_auth_config", "clientId": config.client_id, "redirectUri": config.redirect_uri,
            "secretChanged": current.map(|c| c.client_secret != config.client_secret).unwrap_or(true), "version": version,
        })),
    );
    Ok(Json(google::summary(&state.pool).await?))
}

pub async fn clear_google_config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<serde_json::Value>,
) -> ApiResult<Json<GoogleAuthSummary>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "update_google_auth_config",
        "Only the first user can configure Google sign-in",
    )
    .await?;
    let expected = body.get("expectedVersion").and_then(|v| v.as_i64()).map(|v| v as i32);
    // Accounts keep their Google link, so turning sign-in back on restores it.
    let version = google::save(&state.pool, &state.keyring, None, &auth.user_id, expected).await?;
    state.google.invalidate().await;
    state.settings_changed().await;
    state.audit.log(
        &ctx,
        Event::new("admin.settings.update")
            .resource("settings", None)
            .meta(json!({ "setting": "google_auth_config", "cleared": true, "version": version })),
    );
    Ok(Json(google::summary(&state.pool).await?))
}
