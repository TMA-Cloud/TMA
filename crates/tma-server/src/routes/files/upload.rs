//! Uploads: one file, a batch (folder uploads rebuild their tree from relative
//! paths), replacing a file's bytes, and files derived from another.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Multipart, Path, State};
use serde_json::json;
use tma_core::Permission;
use tma_core::api::{BulkUploadResponse, FileItem, UploadFailure};

use crate::auth::{self, AuthUser};
use crate::error::{ApiError, ApiResult, DomainError};
use crate::middleware::ReqCtx;
use crate::models::files::crud::{self, PlannedUpload};
use crate::models::files::locks::Actor;
use crate::models::users;
use crate::routes::{JsonBody, parent_id};
use crate::services::audit::Event;
use crate::services::events::types;
use crate::services::{cleanup, limits};
use crate::state::AppState;
use crate::transfer::upload::{self, folder_segments};
use crate::util::client_mtime;

fn upload_key(auth: &AuthUser) -> String {
    format!("upload:{}", auth.user_id)
}

/// Refuse up front when the declared size cannot fit (the client uses this before a big upload).
pub async fn check(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<serde_json::Value>,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require(&state, &auth, &ctx, Permission::Upload).await?;
    state.limits.check(limits::UPLOAD, &upload_key(&auth))?;
    let size = body.get("fileSize").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    let Some(size) = size.filter(|s| *s >= 0) else {
        return Err(ApiError::validation("fileSize", "fileSize must be a non-negative integer"));
    };
    let used = users::storage_used(&state.pool, &auth.owner_id).await?;
    if let Some(limit) = users::storage_limit(&state.pool, &auth.owner_id).await?
        && used + size > limit
    {
        return Err(ApiError::storage_limit(format!(
            "Storage limit exceeded. You have used {} of {}. {} available.",
            tma_core::format::file_size(used),
            tma_core::format::file_size(limit),
            tma_core::format::file_size((limit - used).max(0))
        )));
    }
    Ok(Json(json!({ "allowed": true })))
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    if tma_core::names::is_valid_item_name(name) {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!("Invalid file name: {name}")))
    }
}

async fn announce(state: &AppState, owner: &str, file: &FileItem, parent: Option<&str>, event: &str) {
    state
        .events
        .publish(
            owner,
            event,
            json!({ "id": file.id, "name": file.name, "type": file.item_type, "size": file.size, "mimeType": file.mime_type, "parentId": parent, "userId": owner }),
        )
        .await;
}

/// The one row a single-file upload inserts.
async fn insert_one(state: &AppState, planned: &[PlannedUpload], owner: &str) -> ApiResult<FileItem> {
    crud::insert_uploads(&state.pool, planned, owner)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("upload row missing"))
}

/// The file a single-file request carried.
fn first_upload(outcome: &upload::UploadOutcome) -> ApiResult<crud::StreamedUpload> {
    outcome.uploads.first().cloned().ok_or_else(|| ApiError::bad_request("No file uploaded"))
}

async fn owned_file(state: &AppState, id: &str, owner: &str) -> ApiResult<crud::StoredFile> {
    crud::get(&state.pool, id, owner).await?.ok_or_else(|| ApiError::not_found("File not found"))
}

pub async fn single(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    form: Multipart,
) -> ApiResult<Json<FileItem>> {
    auth::require(&state, &auth, &ctx, Permission::Upload).await?;
    state.limits.check(limits::UPLOAD, &upload_key(&auth))?;
    let mut outcome = upload::receive(&state, form, true).await?;
    let file = first_upload(&outcome)?;
    validate_name(&file.name).map_err(|_| ApiError::bad_request("Invalid file name"))?;
    let parent = parent_id(outcome.field("parentId"))?;
    let modified = client_mtime(outcome.field("lastModifiedTimes"));
    let planned = [PlannedUpload { upload: file.clone(), parent_id: parent.clone(), modified, client_id: None }];
    let item = insert_one(&state, &planned, &auth.owner_id).await?;
    outcome.keys.keep_all();
    state.audit.log(
        &ctx,
        Event::new("file.upload")
            .resource("file", Some(&item.id))
            .meta(json!({ "fileName": item.name, "fileSize": item.size })),
    );
    announce(&state, &auth.owner_id, &item, parent.as_deref(), types::FILE_UPLOADED).await;
    cleanup::link_new_items(&state, &auth.owner_id, parent.as_deref(), vec![item.id.clone()]).await;
    Ok(Json(item))
}

/// Create (or reuse) the folders of a relative path; returns the innermost folder.
async fn ensure_folders(
    state: &AppState,
    owner: &str,
    base: Option<&str>,
    segments: &[String],
    cache: &mut HashMap<String, String>,
    created: &mut Vec<String>,
) -> ApiResult<Option<String>> {
    let mut parent = base.map(String::from);
    for segment in segments {
        if !tma_core::names::is_valid_item_name(segment) {
            return Err(ApiError::bad_request(format!("Invalid folder name: {segment}")));
        }
        let key = format!("{}::{segment}", parent.as_deref().unwrap_or("root"));
        if let Some(id) = cache.get(&key) {
            parent = Some(id.clone());
            continue;
        }
        let (folder, was_created) = crud::find_or_create_folder(&state.pool, segment, parent.as_deref(), owner).await?;
        if was_created {
            created.push(folder.id.clone());
            state.events.publish(owner, types::FOLDER_CREATED, json!({ "id": folder.id, "name": folder.name, "type": "folder", "parentId": parent, "userId": owner })).await;
        }
        cache.insert(key, folder.id.clone());
        parent = Some(folder.id);
    }
    Ok(parent)
}

pub async fn bulk(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    form: Multipart,
) -> ApiResult<Json<BulkUploadResponse>> {
    auth::require(&state, &auth, &ctx, Permission::Upload).await?;
    state.limits.check(limits::UPLOAD, &upload_key(&auth))?;
    let mut outcome = upload::receive(&state, form, false).await?;
    let relative = outcome.field_list("relativePaths").to_vec();
    let client_ids = outcome.field_list("clientIds").to_vec();
    let mtimes = outcome.field_list("lastModifiedTimes").to_vec();
    let at = |list: &[String], i: usize| list.get(i).filter(|s| !s.is_empty()).cloned();
    // Joined on the part's own ordinal: refused parts must not shift later files' metadata.
    let mut failed: Vec<UploadFailure> = outcome
        .failures
        .iter()
        .map(|f| UploadFailure {
            file_name: f.file_name.clone(),
            error: f.error.clone(),
            client_id: at(&client_ids, f.index),
        })
        .collect();
    if outcome.uploads.is_empty() {
        return Err(ApiError::bad_request(
            failed.first().map(|f| f.error.clone()).unwrap_or_else(|| "No files uploaded".into()),
        ));
    }
    for u in &outcome.uploads {
        validate_name(&u.name)?;
    }
    let base = parent_id(outcome.field("parentId"))?;
    let mut folders = HashMap::new();
    let mut created_folders = Vec::new();
    let mut planned = Vec::new();
    let mut uploads = outcome.uploads.clone();
    uploads.sort_by_key(|u| u.index);
    for u in uploads {
        let segments = at(&relative, u.index).map(|p| folder_segments(&p, &u.name)).unwrap_or_default();
        let client_id = at(&client_ids, u.index);
        match ensure_folders(&state, &auth.owner_id, base.as_deref(), &segments, &mut folders, &mut created_folders)
            .await
        {
            Ok(parent) => planned.push(PlannedUpload {
                modified: client_mtime(at(&mtimes, u.index).as_deref()),
                upload: u,
                parent_id: parent,
                client_id,
            }),
            Err(err) => failed.push(UploadFailure { file_name: u.name, error: err.message, client_id }),
        }
    }
    let mut successful = Vec::new();
    if !planned.is_empty() {
        match crud::insert_uploads(&state.pool, &planned, &auth.owner_id).await {
            Ok(rows) => {
                let stored: Vec<String> = planned.iter().map(|p| p.upload.storage_name.clone()).collect();
                outcome.keys.keep(&stored);
                for (row, plan) in rows.iter().zip(planned.iter()) {
                    announce(&state, &auth.owner_id, row, plan.parent_id.as_deref(), types::FILE_UPLOADED).await;
                }
                successful = rows;
            }
            Err(err) => {
                let api: ApiError = err.into();
                for p in &planned {
                    failed.push(UploadFailure {
                        file_name: p.upload.name.clone(),
                        error: api.message.clone(),
                        client_id: p.client_id.clone(),
                    });
                }
            }
        }
    }
    if successful.is_empty() {
        return Err(ApiError::bad_request(
            failed.first().map(|f| f.error.clone()).unwrap_or_else(|| "All uploads failed".into()),
        ));
    }
    let mut new_items: Vec<String> = successful.iter().map(|f| f.id.clone()).collect();
    new_items.extend(created_folders);
    cleanup::link_new_items(&state, &auth.owner_id, base.as_deref(), new_items).await;
    let total = outcome.uploads.len() + outcome.failures.len();
    state.audit.log(
        &ctx,
        Event::new("file.upload.bulk").resource("file", successful.first().map(|f| f.id.as_str())).meta(json!({
            "fileCount": successful.len(), "fileIds": successful.iter().map(|f| f.id.clone()).collect::<Vec<_>>(),
            "failedCount": failed.len(), "total": total, "parentId": base, "driver": "s3",
        })),
    );
    let failed_count = failed.len();
    Ok(Json(BulkUploadResponse {
        successful: successful.len(),
        files: successful,
        failed: (!failed.is_empty()).then_some(failed),
        total,
        failed_count,
    }))
}

pub async fn replace(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
    form: Multipart,
) -> ApiResult<Json<FileItem>> {
    auth::require(&state, &auth, &ctx, Permission::Edit).await?;
    state.limits.check(limits::UPLOAD, &upload_key(&auth))?;
    let mut outcome = upload::receive(&state, form, true).await?;
    let upload = first_upload(&outcome)?;
    let existing = owned_file(&state, &id, &auth.owner_id).await?;
    validate_name(&existing.name).map_err(|_| ApiError::bad_request("Invalid file name"))?;
    let modified = client_mtime(outcome.field("lastModifiedTimes"));
    // The content version the client's copy came from; omitted, the save always lands.
    let base = outcome.field("baseVersion").and_then(|v| v.trim().parse::<i64>().ok());
    let replaced = match crud::replace_data(
        &state.pool,
        &id,
        &auth.owner_id,
        &upload,
        modified,
        base,
        Actor { user: &auth.user_id, device: ctx.device.as_deref() },
    )
    .await
    {
        Err(err) if matches!(err.downcast_ref::<DomainError>(), Some(DomainError::Conflict(_))) => {
            // Recorded, so a save someone believes lost can be traced; the client keeps it as a copy.
            state.audit.log(
                &ctx,
                Event::new("file.update")
                    .failure()
                    .resource("file", Some(&id))
                    .meta(json!({ "fileName": existing.name, "reason": "stale_version", "baseVersion": base })),
            );
            return Err(err.into());
        }
        other => other?,
    };
    let (updated, superseded, parent) = replaced.ok_or_else(|| ApiError::not_found("File not found"))?;
    outcome.keys.keep_all();
    if let Some(old) = superseded {
        cleanup::enqueue_object_cleanup(&state, vec![old], "replaced-file-object").await;
    }
    state.audit.log(
        &ctx,
        Event::new("file.update")
            .resource("file", Some(&updated.id))
            .meta(json!({ "fileName": updated.name, "size": updated.size })),
    );
    announce(&state, &auth.owner_id, &updated, parent.as_deref(), types::FILE_UPDATED).await;
    Ok(Json(updated))
}

pub async fn derived(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
    form: Multipart,
) -> ApiResult<Json<FileItem>> {
    auth::require(&state, &auth, &ctx, Permission::Upload).await?;
    state.limits.check(limits::UPLOAD, &upload_key(&auth))?;
    let existing = owned_file(&state, &id, &auth.owner_id).await?;
    let mut outcome = upload::receive(&state, form, true).await?;
    let upload = first_upload(&outcome)?;
    validate_name(&upload.name).map_err(|_| ApiError::bad_request("Invalid file name"))?;
    let planned = [PlannedUpload { upload, parent_id: existing.parent_id.clone(), modified: None, client_id: None }];
    let item = insert_one(&state, &planned, &auth.owner_id).await?;
    outcome.keys.keep_all();
    state.audit.log(
        &ctx,
        Event::new("file.upload")
            .resource("file", Some(&item.id))
            .meta(json!({ "fileName": item.name, "fileSize": item.size, "derivedFrom": existing.id })),
    );
    announce(&state, &auth.owner_id, &item, existing.parent_id.as_deref(), types::FILE_UPLOADED).await;
    cleanup::link_new_items(&state, &auth.owner_id, existing.parent_id.as_deref(), vec![item.id.clone()]).await;
    Ok(Json(item))
}
