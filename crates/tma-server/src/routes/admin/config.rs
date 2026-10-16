//! Instance switches and settings: signup, OnlyOffice, share domain, upload
//! size, proxies, extensions, desktop-only, Cloud Drive, passwords, sessions.

use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use tma_core::api::{ActivitySettings, CloudDriveConfig, SignupStatus};

use crate::auth::{AuthUser, require_first_user};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::models::accounts;
use crate::routes::JsonBody;
use crate::services::audit::Event;
use crate::settings::{self, FlagSetting, is_first_user};
use crate::state::AppState;

fn bool_field(body: &Value, field: &str, message: &str) -> Result<bool, ApiError> {
    body.get(field).and_then(Value::as_bool).ok_or_else(|| ApiError::validation(field, message))
}

fn audit_update(state: &AppState, ctx: &ReqCtx, meta: Value) {
    state.audit.log(ctx, Event::new("admin.settings.update").resource("settings", None).meta(meta));
}

pub async fn signup_status(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<SignupStatus>> {
    let s = state.settings.get().await;
    let first = is_first_user(&state.pool, &state.settings, &auth.user_id).await?;
    let total = if first { Some(accounts::total_users(&state.pool).await?) } else { None };
    Ok(Json(SignupStatus {
        signup_enabled: s.signup_enabled != Some(false),
        can_toggle: first,
        total_users: total,
        additional_users: total.map(|t| (t - 1).max(0)),
        hide_file_extensions: s.hide_file_extensions == Some(true),
        can_toggle_hide_file_extensions: first,
        electron_only_access: s.require_electron_client == Some(true),
        can_toggle_electron_only_access: first,
        allow_password_change: s.allow_password_change == Some(true),
        can_toggle_allow_password_change: first,
    }))
}

/// Shared shape of every "first user flips a boolean" endpoint.
async fn set_flag(
    state: &AppState,
    ctx: &ReqCtx,
    auth: &AuthUser,
    flag: FlagSetting,
    value: bool,
    action: &str,
    forbidden: &str,
) -> ApiResult<()> {
    require_first_user(state, auth, ctx, action, forbidden).await?;
    settings::set_flag(&state.pool, &auth.user_id, flag, value).await?;
    state.settings_changed().await;
    Ok(())
}

pub async fn toggle_signup(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    let enabled = bool_field(&body, "enabled", "Enabled must be a boolean")?;
    set_flag(
        &state,
        &ctx,
        &auth,
        FlagSetting::SignupEnabled,
        enabled,
        "toggle_signup",
        "Only the first user can toggle signup",
    )
    .await?;
    audit_update(&state, &ctx, json!({ "setting": "signup_enabled", "newValue": enabled }));
    Ok(Json(json!({ "signupEnabled": enabled })))
}

pub async fn hide_extensions(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "hideFileExtensions": state.settings.get().await.hide_file_extensions == Some(true) }))
}

pub async fn save_hide_extensions(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    let hidden = bool_field(&body, "hidden", "Hidden must be a boolean")?;
    set_flag(
        &state,
        &ctx,
        &auth,
        FlagSetting::HideFileExtensions,
        hidden,
        "update_hide_file_extensions",
        "Only the first user can configure hide file extensions",
    )
    .await?;
    audit_update(&state, &ctx, json!({ "setting": "hide_file_extensions", "hidden": hidden }));
    Ok(Json(json!({ "hideFileExtensions": hidden })))
}

pub async fn desktop_only(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "electronOnlyAccess": state.settings.get().await.require_electron_client == Some(true) }))
}

pub async fn save_desktop_only(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    let enabled = bool_field(&body, "enabled", "Enabled must be a boolean")?;
    set_flag(
        &state,
        &ctx,
        &auth,
        FlagSetting::RequireDesktopClient,
        enabled,
        "update_electron_only_access",
        "Only the first user can configure desktop-only access",
    )
    .await?;
    audit_update(&state, &ctx, json!({ "setting": "electron_only_access", "enabled": enabled }));
    Ok(Json(json!({ "electronOnlyAccess": enabled })))
}

pub async fn password_change(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "allowPasswordChange": state.settings.get().await.allow_password_change == Some(true) }))
}

pub async fn save_password_change(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    let enabled = bool_field(&body, "enabled", "Enabled must be a boolean")?;
    set_flag(
        &state,
        &ctx,
        &auth,
        FlagSetting::AllowPasswordChange,
        enabled,
        "update_password_change",
        "Only the first user can configure password change",
    )
    .await?;
    audit_update(&state, &ctx, json!({ "setting": "allow_password_change", "enabled": enabled }));
    Ok(Json(json!({ "allowPasswordChange": enabled })))
}

/// Any signed-in user: every desktop app reads the mode it must apply.
pub async fn cloud_drive(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<CloudDriveConfig>> {
    let can_configure = is_first_user(&state.pool, &state.settings, &auth.user_id).await?;
    Ok(Json(CloudDriveConfig { save_only: state.settings.get().await.cloud_drive_save_only, can_configure }))
}

pub async fn save_cloud_drive(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<CloudDriveConfig>> {
    let save_only = match body.get("saveOnly") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) if s == "true" || s == "false" => s == "true",
        _ => return Err(ApiError::validation("saveOnly", "saveOnly must be true or false")),
    };
    set_flag(
        &state,
        &ctx,
        &auth,
        FlagSetting::CloudDriveSaveOnly,
        save_only,
        "update_cloud_drive_mode",
        "Only the first user can configure the Cloud Drive mode",
    )
    .await?;
    audit_update(&state, &ctx, json!({ "setting": "cloud_drive_save_only", "saveOnly": save_only }));
    Ok(Json(CloudDriveConfig { save_only, can_configure: true }))
}

pub async fn onlyoffice_configured(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "configured": state.settings.get().await.onlyoffice().is_some() }))
}

pub async fn onlyoffice_config(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Json<Value>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "get_onlyoffice_config",
        "Only the first user can view OnlyOffice settings",
    )
    .await?;
    let s = state.settings.get().await;
    Ok(Json(json!({ "jwtSecretSet": s.onlyoffice_jwt_secret.is_some(), "url": s.onlyoffice_url })))
}

pub async fn save_onlyoffice_config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    require_first_user(&state, &auth, &ctx, "update_onlyoffice_config", "Only the first user can configure OnlyOffice")
        .await?;
    let text = |f: &str| body.get(f).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let (secret, url) = (text("jwtSecret"), text("url"));
    settings::set_onlyoffice(&state.pool, &auth.user_id, secret.clone(), url.clone()).await?;
    state.settings_changed().await;
    audit_update(&state, &ctx, json!({ "setting": "onlyoffice_config", "hasJwtSecret": secret.is_some(), "url": url }));
    let s = state.settings.get().await;
    Ok(Json(json!({ "jwtSecretSet": s.onlyoffice_jwt_secret.is_some(), "url": s.onlyoffice_url })))
}

pub async fn share_base_url(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Json<Value>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "get_share_base_url_config",
        "Only the first user can view share base URL settings",
    )
    .await?;
    Ok(Json(json!({ "url": state.settings.get().await.share_base_url })))
}

pub async fn save_share_base_url(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "update_share_base_url_config",
        "Only the first user can configure share base URL",
    )
    .await?;
    let url = body.get("url").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    settings::set_share_base_url(&state.pool, &auth.user_id, url.clone()).await?;
    state.settings_changed().await;
    audit_update(&state, &ctx, json!({ "setting": "share_base_url_config", "url": url }));
    Ok(Json(json!({ "url": state.settings.get().await.share_base_url })))
}

pub async fn max_upload(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "maxBytes": state.settings.get().await.max_upload_bytes() }))
}

pub async fn save_max_upload(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "update_max_upload_size_config",
        "Only the first user can configure max upload size",
    )
    .await?;
    let max = body.get("maxBytes").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    let max =
        max.filter(|m| (settings::MIN_MAX_UPLOAD_BYTES..=settings::MAX_MAX_UPLOAD_BYTES).contains(m)).ok_or_else(
            || ApiError::validation("maxBytes", "Max upload size must be between 1 MB and 100 GB (in bytes)"),
        )?;
    settings::set_max_upload(&state.pool, &auth.user_id, max).await?;
    state.settings_changed().await;
    audit_update(&state, &ctx, json!({ "setting": "max_upload_size_config", "maxBytes": max }));
    Ok(Json(json!({ "maxBytes": max })))
}

pub async fn known_proxies(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Json<Value>> {
    require_first_user(&state, &auth, &ctx, "read_known_proxies", "Only the first user can view known proxies").await?;
    let list = settings::normalize_known_proxies(&state.settings.get().await.known_proxies).unwrap_or_default();
    Ok(Json(json!({ "knownProxies": list })))
}

pub async fn save_known_proxies(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    require_first_user(&state, &auth, &ctx, "update_known_proxies", "Only the first user can configure known proxies")
        .await?;
    let raw: Vec<String> = match body.get("knownProxies") {
        Some(Value::Array(items)) if items.len() <= 100 => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(String::from)
                    .ok_or_else(|| ApiError::validation("knownProxies", "Each known proxy must be a string"))
            })
            .collect::<Result<_, _>>()?,
        _ => {
            return Err(ApiError::validation(
                "knownProxies",
                "Known proxies must be an array with at most 100 entries",
            ));
        }
    };
    let saved = settings::set_known_proxies(&state.pool, &auth.user_id, &raw).await?;
    state.settings_changed().await;
    audit_update(&state, &ctx, json!({ "setting": "known_proxies", "count": saved.len() }));
    Ok(Json(json!({ "knownProxies": saved, "restartRequired": true })))
}

pub async fn activity(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Json<ActivitySettings>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "read_activity_settings",
        "Only the first user can manage session and access-time settings",
    )
    .await?;
    Ok(Json(state.settings.get().await.activity()))
}

fn int_field(body: &Value, field: &str) -> Option<i64> {
    body.get(field).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

pub async fn save_session_timeout(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<ActivitySettings>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "update_activity_settings",
        "Only the first user can manage session and access-time settings",
    )
    .await?;
    let days = int_field(&body, "idleDays")
        .ok_or_else(|| ApiError::validation("idleDays", "Session idle timeout (days) must be 1 to 365"))?;
    settings::set_idle_days(&state.pool, &auth.user_id, days).await?;
    state.settings_changed().await;
    let saved = state.settings.get().await.activity();
    audit_update(&state, &ctx, json!({ "setting": "session_idle_days", "sessionIdleDays": saved.session_idle_days }));
    Ok(Json(saved))
}

pub async fn save_access_time(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<ActivitySettings>> {
    require_first_user(
        &state,
        &auth,
        &ctx,
        "update_activity_settings",
        "Only the first user can manage session and access-time settings",
    )
    .await?;
    let enabled = match body.get("enabled") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) if s == "true" || s == "false" => s == "true",
        _ => return Err(ApiError::validation("enabled", "Enabled must be true or false")),
    };
    let window = int_field(&body, "windowMinutes")
        .ok_or_else(|| ApiError::validation("windowMinutes", "Access time window (minutes) must be 0 to 1440"))?;
    let flush = int_field(&body, "flushSeconds")
        .ok_or_else(|| ApiError::validation("flushSeconds", "Write interval (seconds) must be 1 to 300"))?;
    settings::set_access_time(&state.pool, &auth.user_id, enabled, window, flush).await?;
    state.settings_changed().await;
    let saved = state.settings.get().await.activity();
    audit_update(&state, &ctx, json!({ "setting": "access_time", "accessTimeTracking": saved.access_time_tracking }));
    Ok(Json(saved))
}
