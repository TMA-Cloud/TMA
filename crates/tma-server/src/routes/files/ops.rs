//! Changing files: folders, copy, move, rename, star, trash and restore.
//! Large trees and anything touching many objects go to the worker.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use tma_core::Permission;
use tma_core::api::FileItem;

use crate::auth::{self, AuthUser};
use crate::error::{ApiError, ApiResult, message};
use crate::jobs::queues;
use crate::middleware::ReqCtx;
use crate::models::files::listing::{self, Brief};
use crate::models::files::{crud, ops, trash as trash_model};
use crate::models::shares;
use crate::routes::{JsonBody, parent_id, require_ids};
use crate::services::audit::Event;
use crate::services::cleanup;
use crate::services::events::types;
use crate::state::AppState;

/// Trees above this size are trashed or restored by the worker.
const ASYNC_TREE_THRESHOLD: i64 = 1000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdsBody {
    ids: Option<Vec<String>>,
    parent_id: Option<String>,
    starred: Option<bool>,
}

fn bulk_audit(action: &str, items: &[Brief], extra: serde_json::Value) -> Event {
    let mut meta = json!({
        "fileCount": items.len(),
        "fileIds": items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        "fileNames": items.iter().map(|i| i.name.clone()).collect::<Vec<_>>(),
        "fileTypes": items.iter().map(|i| i.item_type.clone()).collect::<Vec<_>>(),
    });
    if let (Some(m), Some(e)) = (meta.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    Event::new(action)
        .resource(items.first().map(|i| i.item_type.as_str()).unwrap_or("file"), items.first().map(|i| i.id.as_str()))
        .meta(meta)
}

/// A large tree goes to the worker: queue `task` for it, audit that, and answer that it is queued.
async fn queue_tree(
    state: &AppState,
    ctx: &ReqCtx,
    owner: &str,
    task: &str,
    (ids, items, tree): (&[String], &[Brief], i64),
    event: &str,
    text: &str,
) -> ApiResult<Response> {
    let body = json!({ "task": task, "ids": ids, "userId": owner });
    let job = state.jobs.send(queues::FILE_OPERATIONS, body, Some(owner), 0).await?;
    state.audit.log(ctx, bulk_audit(event, items, json!({ "treeCount": tree })));
    Ok(queued(job, text))
}

fn queued(job: uuid::Uuid, text: &str) -> Response {
    (StatusCode::ACCEPTED, Json(json!({ "message": text, "queued": true, "jobId": job }))).into_response()
}

pub async fn add_folder(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<serde_json::Value>,
) -> ApiResult<Json<FileItem>> {
    auth::require(&state, &auth, &ctx, Permission::Upload).await?;
    let name = body.get("name").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
    if name.is_empty() {
        return Err(ApiError::validation("name", "Folder name is required"));
    }
    if !tma_core::names::is_valid_item_name(name) {
        return Err(ApiError::validation("name", "Names can be up to 255 characters and cannot contain / or \\"));
    }
    let parent = parent_id(body.get("parentId").and_then(|v| v.as_str()))?;
    let folder = crud::create_folder(&state.pool, name, parent.as_deref(), &auth.owner_id).await?;
    state.audit.log(
        &ctx,
        Event::new("folder.create")
            .resource("folder", Some(&folder.id))
            .meta(json!({ "folderName": name, "parentId": parent })),
    );
    state.events.publish(&auth.owner_id, types::FOLDER_CREATED, json!({ "id": folder.id, "name": folder.name, "type": "folder", "parentId": parent, "userId": auth.owner_id })).await;
    cleanup::link_new_items(&state, &auth.owner_id, parent.as_deref(), vec![folder.id.clone()]).await;
    Ok(Json(folder))
}

/// The paste target (a file target means its folder) and the items, all of which must still exist.
async fn paste_context(
    state: &AppState,
    auth: &AuthUser,
    body: &IdsBody,
) -> ApiResult<(Vec<String>, Option<String>, Vec<Brief>, String)> {
    let ids = require_ids(&body.ids)?;
    let requested = parent_id(body.parent_id.as_deref())?;
    let target = listing::resolve_target_folder(&state.pool, requested.as_deref(), &auth.owner_id).await?;
    let items = listing::briefs(&state.pool, &ids, &auth.owner_id, false).await?;
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    if items.len() != unique.len() {
        return Err(ApiError::not_found("Some items no longer exist or are in the trash"));
    }
    let folder_name = listing::folder_name(&state.pool, target.as_deref(), &auth.owner_id).await?;
    Ok((ids, target, items, folder_name))
}

pub async fn copy(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<IdsBody>,
) -> ApiResult<Response> {
    auth::require(&state, &auth, &ctx, Permission::Upload).await?;
    let (ids, target, items, folder_name) = paste_context(&state, &auth, &body).await?;
    // Copying a tree may need many server-side object copies: the request only hands it over.
    let data = json!({ "task": "copy", "ids": ids, "userId": auth.owner_id, "parentId": target, "targetFolderName": folder_name });
    let job = state.jobs.send(queues::FILE_OPERATIONS, data, Some(&auth.owner_id), 0).await?;
    state.audit.log(
        &ctx,
        bulk_audit(
            "file.copy.queued",
            &items,
            json!({ "targetParentId": target, "targetFolderName": folder_name, "jobId": job }),
        ),
    );
    Ok(queued(job, "Copy queued."))
}

pub async fn move_items(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<IdsBody>,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require(&state, &auth, &ctx, Permission::Edit).await?;
    let (ids, target, items, folder_name) = paste_context(&state, &auth, &body).await?;
    ops::move_items(&state.pool, &ids, target.as_deref(), &auth.owner_id).await?;
    state.audit.log(
        &ctx,
        bulk_audit("file.move", &items, json!({ "targetParentId": target, "targetFolderName": folder_name })),
    );
    let events = items
        .iter()
        .map(|i| (types::FILE_MOVED, json!({ "id": i.id, "name": i.name, "type": i.item_type, "parentId": target, "targetFolderName": folder_name, "userId": auth.owner_id })))
        .collect();
    state.events.publish_batch(&auth.owner_id, events).await;
    cleanup::link_new_items(&state, &auth.owner_id, target.as_deref(), ids).await;
    Ok(message("Files moved successfully."))
}

pub async fn rename(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<serde_json::Value>,
) -> ApiResult<Json<FileItem>> {
    auth::require(&state, &auth, &ctx, Permission::Edit).await?;
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::validation("id", "File ID is required"))?;
    let name = body.get("name").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
    if name.is_empty() {
        return Err(ApiError::validation("name", "New name is required"));
    }
    if !tma_core::names::is_valid_item_name(name) {
        return Err(ApiError::validation("name", "Names can be up to 255 characters and cannot contain / or \\"));
    }
    let (file, old_name, parent) =
        crud::rename(&state.pool, id, name, &auth.owner_id).await?.ok_or_else(|| ApiError::not_found("Not found"))?;
    state.audit.log(
        &ctx,
        Event::new("file.rename")
            .resource(file.item_type.as_str(), Some(id))
            .meta(json!({ "newName": name, "oldName": old_name })),
    );
    state.events.publish(&auth.owner_id, types::FILE_RENAMED, json!({ "id": id, "name": name, "oldName": old_name, "type": file.item_type, "parentId": parent, "userId": auth.owner_id })).await;
    let mut file = file;
    file.parent_id = parent;
    Ok(Json(file))
}

pub async fn star(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<IdsBody>,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require(&state, &auth, &ctx, Permission::Edit).await?;
    let ids = require_ids(&body.ids)?;
    let starred = body.starred.ok_or_else(|| ApiError::validation("starred", "Starred must be a boolean"))?;
    let items = listing::briefs(&state.pool, &ids, &auth.owner_id, false).await?;
    crud::set_starred(&state.pool, &ids, starred, &auth.owner_id).await?;
    state.audit.log(
        &ctx,
        bulk_audit(if starred { "file.star" } else { "file.unstar" }, &items, json!({ "starred": starred })),
    );
    let events = items
        .iter()
        .map(|i| (types::FILE_STARRED, json!({ "id": i.id, "name": i.name, "type": i.item_type, "parentId": i.parent_id, "starred": starred, "userId": auth.owner_id })))
        .collect();
    state.events.publish_batch(&auth.owner_id, events).await;
    Ok(message("File starred status updated."))
}

fn wants_progress(headers: &HeaderMap) -> bool {
    headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("application/x-ndjson"))
}

pub async fn trash(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    headers: HeaderMap,
    JsonBody(body): JsonBody<IdsBody>,
) -> ApiResult<Response> {
    auth::require(&state, &auth, &ctx, Permission::Delete).await?;
    let ids = require_ids(&body.ids)?;
    let items = listing::briefs(&state.pool, &ids, &auth.owner_id, false).await?;
    let tree = trash_model::count_tree(&state.pool, &ids, &auth.owner_id, false, false).await?;
    if tree > ASYNC_TREE_THRESHOLD {
        return queue_tree(
            &state,
            &ctx,
            &auth.owner_id,
            "trash",
            (&ids, &items, tree),
            "file.delete.queued",
            "Move to trash queued.",
        )
        .await;
    }
    let run = {
        let (state, owner) = (state.clone(), auth.owner_id.clone());
        move |chunk: Vec<String>| {
            let (state, owner) = (state.clone(), owner.clone());
            async move {
                let trashed = trash_model::trash(&state.pool, &chunk, &owner).await?;
                shares::forget_tokens(&state.cache, trash_model::shares_containing(&state.pool, &trashed).await?).await;
                anyhow::Ok(())
            }
        }
    };
    state.audit.log(&ctx, bulk_audit("file.delete", &items, json!({ "permanent": false })));
    let done_message = "Files moved to trash.";
    let publish = trash_event(&state, &auth, types::FILE_DELETED, "trash", ids.len());
    if wants_progress(&headers) {
        return Ok(super::progress::stream(ids, run, done_message.to_string(), publish));
    }
    run(ids).await?;
    publish.await;
    Ok(message(done_message).into_response())
}

fn trash_event(
    state: &AppState,
    auth: &AuthUser,
    event: &'static str,
    action: &'static str,
    count: usize,
) -> impl std::future::Future<Output = ()> + Send + 'static {
    let (state, owner) = (state.clone(), auth.owner_id.clone());
    async move {
        state
            .events
            .publish_batch(&owner, vec![(event, json!({ "userId": owner, "action": action, "count": count }))])
            .await
    }
}

pub async fn restore(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    headers: HeaderMap,
    JsonBody(body): JsonBody<IdsBody>,
) -> ApiResult<Response> {
    auth::require(&state, &auth, &ctx, Permission::Restore).await?;
    let ids = require_ids(&body.ids)?;
    let items = listing::briefs(&state.pool, &ids, &auth.owner_id, true).await?;
    if items.is_empty() {
        return Err(ApiError::not_found("No files found in trash to restore"));
    }
    let tree = trash_model::count_tree(&state.pool, &ids, &auth.owner_id, true, false).await?;
    if tree > ASYNC_TREE_THRESHOLD {
        return queue_tree(
            &state,
            &ctx,
            &auth.owner_id,
            "restore",
            (&ids, &items, tree),
            "file.restore.queued",
            "Restore queued.",
        )
        .await;
    }
    let run = {
        let (pool, owner) = (state.pool.clone(), auth.owner_id.clone());
        move |chunk: Vec<String>| {
            let (pool, owner) = (pool.clone(), owner.clone());
            async move { trash_model::restore(&pool, &chunk, &owner).await.map(|_| ()) }
        }
    };
    state.audit.log(&ctx, bulk_audit("file.restore", &items, json!({})));
    let done_message = format!("Restored {} file(s) from trash", items.len());
    let events: Vec<(&str, serde_json::Value)> = items
        .iter()
        .map(|i| (types::FILE_RESTORED, json!({ "id": i.id, "name": i.name, "type": i.item_type, "parentId": i.parent_id, "userId": auth.owner_id })))
        .collect();
    let publish = {
        let (state, owner) = (state.clone(), auth.owner_id.clone());
        async move { state.events.publish_batch(&owner, events).await }
    };
    if wants_progress(&headers) {
        return Ok(super::progress::stream(ids, run, done_message.clone(), publish));
    }
    run(ids).await?;
    publish.await;
    Ok(message(done_message).into_response())
}

pub async fn delete_forever(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<IdsBody>,
) -> ApiResult<Response> {
    auth::require(&state, &auth, &ctx, Permission::Purge).await?;
    let ids = require_ids(&body.ids)?;
    let items = listing::briefs(&state.pool, &ids, &auth.owner_id, true).await?;
    let tree = trash_model::count_tree(&state.pool, &ids, &auth.owner_id, true, false).await?;
    // Object deletion is retryable, multi-batch I/O: always the worker's job.
    let job = state
        .jobs
        .send(
            queues::FILE_OPERATIONS,
            json!({ "task": "delete-permanently", "ids": ids, "userId": auth.owner_id }),
            Some(&auth.owner_id),
            0,
        )
        .await?;
    state.audit.log(&ctx, bulk_audit("file.delete.permanent.queued", &items, json!({ "treeCount": tree })));
    Ok(queued(job, "Permanent deletion queued."))
}

pub async fn empty_trash(State(state): State<AppState>, ctx: ReqCtx, auth: AuthUser) -> ApiResult<Response> {
    auth::require(&state, &auth, &ctx, Permission::Purge).await?;
    let count = trash_model::count_tree(&state.pool, &[], &auth.owner_id, true, true).await?;
    if count == 0 {
        return Ok(message("Trash is already empty").into_response());
    }
    let job = state
        .jobs
        .send(
            queues::FILE_OPERATIONS,
            json!({ "task": "empty-trash", "ids": [], "userId": auth.owner_id }),
            Some(&auth.owner_id),
            0,
        )
        .await?;
    state.audit.log(
        &ctx,
        Event::new("file.delete.permanent.queued")
            .resource("file", None)
            .meta(json!({ "fileCount": count, "permanent": true, "action": "empty_trash", "jobId": job })),
    );
    Ok(queued(job, &format!("Deletion of {count} item(s) queued")))
}
