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
use crate::models::files::locks::{self, Actor, Taken};
use crate::services::audit::Event;
use crate::state::AppState;

fn actor<'a>(auth: &'a AuthUser, ctx: &'a ReqCtx) -> Actor<'a> {
    Actor { user: &auth.user_id, device: ctx.device.as_deref() }
}

pub async fn take(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<LockResponse>> {
    auth::require(&state, &auth, &ctx, Permission::Edit).await?;
    let taken = locks::acquire(&state.pool, &id, &auth.owner_id, actor(&auth, &ctx), locks::LEASE)
        .await?
        .ok_or_else(|| ApiError::not_found("File not found"))?;
    Ok(Json(match taken {
        Taken::Held { lock, fresh } => {
            if fresh {
                state.audit.log(&ctx, Event::new("file.lock").resource("file", Some(&id)));
                state.events.lock_changed(&auth.owner_id, &id).await;
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
    if locks::release(&state.pool, &id, actor(&auth, &ctx)).await? {
        state.audit.log(&ctx, Event::new("file.unlock").resource("file", Some(&id)));
        state.events.lock_changed(&auth.owner_id, &id).await;
    }
    Ok(Json(json!({ "released": true })))
}
