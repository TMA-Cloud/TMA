//! The signed-in devices list and presence heartbeats.

use axum::extract::{Path, Query, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tma_core::api::{RevokeOthersResponse, SessionList};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult, message};
use crate::middleware::ReqCtx;
use crate::models::{sessions, users};
use crate::services::audit::Event;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/sessions", get(list))
        .route("/sessions/heartbeat", post(heartbeat))
        .route("/sessions/offline", post(offline))
        .route("/sessions/revoke-others", post(revoke_others))
        .route("/sessions/{session_id}", delete(revoke))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    refresh_ip: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<SessionList>> {
    let user = users::by_id(&state, &auth.user_id).await?.ok_or_else(|| ApiError::not_found("User not found"))?;
    if q.refresh_ip.as_deref() == Some("true")
        && let Some(sid) = &auth.session_id
    {
        // The middleware's touch is fire-and-forget; an explicit refresh waits for this device's address.
        sessions::touch(&state.pool, sid, ctx.ip.as_deref()).await?;
    }
    let mut list = sessions::active(&state.pool, &auth.user_id, user.token_version).await?;
    for s in &mut list {
        s.is_current = auth.session_id.as_deref() == Some(s.id.as_str());
    }
    Ok(Json(SessionList { sessions: list }))
}

async fn heartbeat(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Json<serde_json::Value>> {
    let sid = auth.session_id.as_deref().ok_or_else(|| ApiError::unauthorized("Active session not found"))?;
    let beat = sessions::Heartbeat {
        client_id: None,
        session_id: Some(sid),
        app_version: "web",
        platform: Some("web"),
        user_agent: ctx.user_agent.as_deref(),
        ip: ctx.ip.as_deref(),
    };
    sessions::heartbeat(&state.pool, &auth.user_id, &beat).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn offline(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<serde_json::Value>> {
    let sid = auth.session_id.as_deref().ok_or_else(|| ApiError::unauthorized("Active session not found"))?;
    sessions::delete_heartbeat(&state.pool, &auth.user_id, sid).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn revoke(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(session_id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    if !sessions::delete(&state, &session_id, &auth.user_id).await? {
        return Err(ApiError::not_found("Session not found"));
    }
    sessions::delete_heartbeat(&state.pool, &auth.user_id, &session_id).await?;
    state.audit.log(&ctx, Event::new("auth.session_revoked").resource("auth", Some(&session_id)));
    Ok(message("Session revoked successfully"))
}

async fn revoke_others(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
) -> ApiResult<Json<RevokeOthersResponse>> {
    let user = users::by_id(&state, &auth.user_id).await?.ok_or_else(|| ApiError::not_found("User not found"))?;
    let current = auth.session_id.as_deref().ok_or_else(|| ApiError::bad_request("Current session not found"))?;
    let deleted = sessions::delete_others(&state, &auth.user_id, current, user.token_version).await?;
    sessions::delete_other_heartbeats(&state.pool, &auth.user_id, current).await?;
    state.audit.log(
        &ctx,
        Event::new("auth.other_sessions_revoked")
            .resource("auth", Some(&auth.user_id))
            .meta(json!({ "deletedCount": deleted })),
    );
    Ok(Json(RevokeOthersResponse { message: "Other sessions revoked successfully".into(), deleted_count: deleted }))
}
