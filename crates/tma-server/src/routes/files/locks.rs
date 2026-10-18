//! `/api/files/:id/lock`: the desktop app takes (and keeps renewing) an edit lock
//! while a file is open for editing, and gives it up when the file closes.

use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use tma_core::Permission;
use tma_core::api::LockResponse;

use crate::auth::{self, AuthUser};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::models::files::locks::{self, Taken};
use crate::services::audit::Event;
use crate::services::events::types;
use crate::state::AppState;

/// Others' lists and drives refresh when a file starts or stops being edited, not on every renewal.
async fn announce(state: &AppState, owner: &str, id: &str) {
    state.events.publish(owner, types::FILE_UPDATED, json!({ "id": id, "userId": owner, "lock": true })).await;
}

pub async fn take(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<LockResponse>> {
    auth::require(&state, &auth, &ctx, Permission::Edit).await?;
    let taken = locks::acquire(&state.pool, &id, &auth.owner_id, &auth.user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("File not found"))?;
    Ok(Json(match taken {
        Taken::Held { lock, fresh } => {
            if fresh {
                state.audit.log(&ctx, Event::new("file.lock").resource("file", Some(&id)));
                announce(&state, &auth.owner_id, &id).await;
            }
            LockResponse { acquired: true, lock }
        }
        Taken::Busy(lock) => LockResponse { acquired: false, lock },
    }))
}

pub async fn give_up(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    if locks::release(&state.pool, &id, &auth.user_id).await? {
        state.audit.log(&ctx, Event::new("file.unlock").resource("file", Some(&id)));
        announce(&state, &auth.owner_id, &id).await;
    }
    Ok(Json(json!({ "released": true })))
}
