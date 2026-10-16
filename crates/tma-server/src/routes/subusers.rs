//! `/api/user/sub-users`: logins an owner adds to their own account, each with
//! a set of granted permissions. Only owners reach these handlers.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::json;
use tma_core::api::{CreateSubUserRequest, MessageResponse, SubUserEnvelope, SubUserList, UpdateSubUserRequest};

use crate::auth::{AuthUser, password, require_owner};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::models::{accounts, sessions, users};
use crate::routes::JsonBody;
use crate::services::audit::Event;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/sub-users", get(list).post(create)).route("/sub-users/{id}", put(update).delete(remove))
}

pub async fn list(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Json<SubUserList>> {
    require_owner(&state, &auth, &ctx)?;
    let sub_users = accounts::list_sub_users(&state.pool, &auth.user_id).await?;
    Ok(Json(SubUserList { sub_users, available_permissions: tma_core::permissions::catalog() }))
}

pub async fn create(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<CreateSubUserRequest>,
) -> ApiResult<Response> {
    require_owner(&state, &auth, &ctx)?;
    let email = super::auth::checked_email(&body.email)?;
    password::check_new_password(&body.password, "Password").map_err(|m| ApiError::validation("password", m))?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::validation("name", "Name is required"));
    }
    if name.chars().count() > 100 {
        return Err(ApiError::validation("name", "Name must not exceed 100 characters"));
    }
    if users::by_email(&state.pool, &email).await?.is_some() {
        state.audit.log(
            &ctx,
            Event::new("account.sub_user.create")
                .failure()
                .resource("user", None)
                .meta(json!({ "email": email, "reason": "email_already_in_use" })),
        );
        return Err(ApiError::conflict("Email already in use"));
    }
    let hash = password::hash(&body.password).await?;
    let sub_user =
        accounts::create_sub_user(&state.pool, &auth.user_id, &email, &hash, name, &body.permissions).await?;
    state.audit.log(
        &ctx,
        Event::new("account.sub_user.create")
            .resource("user", Some(&sub_user.id))
            .meta(json!({ "email": email, "permissions": sub_user.permissions })),
    );
    tracing::info!(owner_id = %auth.user_id, sub_user_id = %sub_user.id, "Sub-user created");
    Ok((StatusCode::CREATED, Json(SubUserEnvelope { sub_user })).into_response())
}

pub async fn update(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<UpdateSubUserRequest>,
) -> ApiResult<Json<SubUserEnvelope>> {
    require_owner(&state, &auth, &ctx)?;
    let sub_user = accounts::update_sub_user(&state.pool, &auth.user_id, &id, &body.permissions)
        .await?
        .ok_or_else(|| ApiError::not_found("Sub-user not found"))?;
    // Cached grants would let the old permissions linger until the TTL.
    users::forget(&state, &id).await;
    state.audit.log(
        &ctx,
        Event::new("account.sub_user.update")
            .resource("user", Some(&id))
            .meta(json!({ "permissions": sub_user.permissions })),
    );
    Ok(Json(SubUserEnvelope { sub_user }))
}

pub async fn remove(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<MessageResponse>> {
    require_owner(&state, &auth, &ctx)?;
    let existing = accounts::get_sub_user(&state.pool, &auth.user_id, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Sub-user not found"))?;
    // The files were always the owner's; only the login and its sessions go.
    sessions::delete_all(&state, &id).await?;
    sessions::delete_all_heartbeats(&state.pool, &id).await?;
    accounts::delete_sub_user(&state.pool, &auth.user_id, &id).await?;
    users::forget(&state, &id).await;
    state.audit.log(
        &ctx,
        Event::new("account.sub_user.delete")
            .resource("user", Some(&id))
            .meta(json!({ "email": existing.email, "permissions": existing.permissions })),
    );
    Ok(Json(MessageResponse { message: "Sub-user removed".into() }))
}
