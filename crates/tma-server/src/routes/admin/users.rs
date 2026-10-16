//! User administration, storage figures, desktop clients and orphan review.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tma_core::api::{ActiveClients, AdminUserPage, ClientHeartbeat, StorageLimitRequest, StorageUsage};

use crate::auth::{AuthUser, require_first_user};
use crate::error::{ApiError, ApiResult};
use crate::jobs::queues;
use crate::middleware::ReqCtx;
use crate::models::files::orphans;
use crate::models::{accounts, sessions, users};
use crate::routes::JsonBody;
use crate::services::audit::Event;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct PageQuery {
    limit: Option<String>,
    cursor: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<AdminUserPage>> {
    if require_first_user(&state, &auth, &ctx, "list_users", "Only the first user can view all users").await.is_err() {
        state.audit.log(
            &ctx,
            Event::new("admin.user.list").failure().resource("user", None).meta(json!({ "reason": "unauthorized" })),
        );
        return Err(ApiError::forbidden("Only the first user can view all users"));
    }
    let (users, next_cursor) =
        accounts::list_users(&state.pool, q.limit.and_then(|l| l.parse().ok()), q.cursor.as_deref()).await?;
    state
        .audit
        .log(&ctx, Event::new("admin.user.list").resource("user", None).meta(json!({ "userCount": users.len() })));
    Ok(Json(AdminUserPage { users, next_cursor }))
}

pub async fn storage_usage(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<StorageUsage>> {
    let used = users::storage_used(&state.pool, &auth.owner_id).await?;
    let total = users::storage_limit(&state.pool, &auth.owner_id).await?;
    Ok(Json(StorageUsage { used, total, free: total.map(|t| (t - used).max(0)) }))
}

pub async fn set_storage_limit(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<StorageLimitRequest>,
) -> ApiResult<Json<Value>> {
    if !crate::settings::is_first_user(&state.pool, &state.settings, &auth.user_id).await? {
        state.audit.log(
            &ctx,
            Event::new("admin.user.update")
                .failure()
                .resource("user", None)
                .meta(json!({ "action": "update_storage_limit", "reason": "unauthorized" })),
        );
        return Err(ApiError::forbidden("Only the first user can set storage limits"));
    }
    accounts::set_storage_limit(&state.pool, &auth.user_id, &body.target_user_id, body.storage_limit).await?;
    state.audit.log(
        &ctx,
        Event::new("admin.user.update").resource("user", None).meta(json!({ "action": "update_storage_limit", "targetUserId": body.target_user_id, "storageLimit": body.storage_limit })),
    );
    Ok(Json(json!({ "storageLimit": body.storage_limit })))
}

pub async fn client_heartbeat(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<ClientHeartbeat>,
) -> ApiResult<Json<Value>> {
    if body.app_version.trim().is_empty() {
        return Err(ApiError::bad_request("appVersion is required"));
    }
    let client = body.client_id.as_deref().map(str::trim).filter(|c| !c.is_empty());
    let beat = sessions::Heartbeat {
        client_id: client,
        session_id: auth.session_id.as_deref(),
        app_version: &body.app_version,
        platform: body.platform.as_deref(),
        user_agent: ctx.user_agent.as_deref(),
        ip: ctx.ip.as_deref(),
    };
    sessions::heartbeat(&state.pool, &auth.user_id, &beat).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn active_clients(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
) -> ApiResult<Json<ActiveClients>> {
    require_first_user(&state, &auth, &ctx, "read_active_clients", "Only the first user can view active clients")
        .await?;
    Ok(Json(ActiveClients { clients: accounts::active_clients(&state.pool, 5).await? }))
}

/// A queued orphan job's state, or its result once done.
async fn job_reply(state: &AppState, job_id: &str, auth: &AuthUser, what: &str) -> ApiResult<Response> {
    let id = uuid::Uuid::parse_str(job_id).map_err(|_| ApiError::not_found(format!("Orphan {what} job not found")))?;
    let job = state
        .jobs
        .get(queues::ORPHANS, id)
        .await?
        .filter(|j| j.data.get("requestedBy").and_then(|v| v.as_str()) == Some(auth.user_id.as_str()))
        .ok_or_else(|| ApiError::not_found(format!("Orphan {what} job not found")))?;
    match job.state.as_str() {
        "failed" | "cancelled" => {
            Err(ApiError::internal_msg(&format!("Orphan {what} failed"), job.error.unwrap_or_default()))
        }
        "completed" => Ok(Json(job.output.unwrap_or_default()).into_response()),
        _ => Ok((StatusCode::ACCEPTED, Json(json!({ "jobId": job.id, "status": job.state }))).into_response()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanQuery {
    job_id: Option<String>,
    grace_minutes: Option<String>,
}

pub async fn orphans(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Query(q): Query<OrphanQuery>,
) -> ApiResult<Response> {
    require_first_user(&state, &auth, &ctx, "scan_orphans", "Only the first user can review orphaned files").await?;
    if let Some(job) = q.job_id.as_deref() {
        return job_reply(&state, job, &auth, "scan").await;
    }
    let grace = match q.grace_minutes.as_deref() {
        Some(g) => Some(g.parse::<i64>().ok().filter(|g| (60..=525_600).contains(g)).ok_or_else(|| {
            ApiError::validation("graceMinutes", "Grace window must be between 60 minutes and 1 year")
        })?),
        None => None,
    };
    let grace = orphans::normalize_grace(grace);
    let job = state
        .jobs
        .send(queues::ORPHANS, json!({ "task": "scan", "graceMinutes": grace, "requestedBy": auth.user_id }), None, 0)
        .await?;
    state.audit.log(
        &ctx,
        Event::new("admin.orphans.scan")
            .resource("settings", None)
            .meta(json!({ "graceMinutes": grace, "jobId": job })),
    );
    Ok((StatusCode::ACCEPTED, Json(json!({ "jobId": job, "status": "created" }))).into_response())
}

pub async fn delete_orphans(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Response> {
    require_first_user(&state, &auth, &ctx, "delete_orphans", "Only the first user can review orphaned files").await?;
    if let Some(job) = body.get("jobId").and_then(Value::as_str) {
        return job_reply(&state, job, &auth, "cleanup").await;
    }
    let strings = |field: &str| -> Result<Vec<String>, ApiError> {
        match body.get(field) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) if items.len() <= 500 => items
                .iter()
                .map(|v| {
                    v.as_str().map(String::from).ok_or_else(|| ApiError::validation(field, "Entries must be strings"))
                })
                .collect(),
            Some(_) => Err(ApiError::validation(field, "Provide at most 500 entries per request")),
        }
    };
    let (keys, ids) = (strings("storageKeys")?, strings("fileIds")?);
    if keys.is_empty() && ids.is_empty() {
        return Err(ApiError::bad_request("Select at least one orphan to delete"));
    }
    let grace = body.get("graceMinutes").and_then(Value::as_i64);
    let data = json!({ "task": "delete", "storageKeys": keys, "fileIds": ids, "graceMinutes": grace, "requestedBy": auth.user_id });
    let job = state.jobs.send(queues::ORPHANS, data, None, 0).await?;
    state.audit.log(&ctx, Event::new("admin.orphans.delete").resource("file", None).meta(json!({ "graceMinutes": grace, "requestedStorage": keys.len(), "requestedDatabase": ids.len(), "jobId": job })));
    Ok((StatusCode::ACCEPTED, Json(json!({ "jobId": job, "status": "created" }))).into_response())
}
