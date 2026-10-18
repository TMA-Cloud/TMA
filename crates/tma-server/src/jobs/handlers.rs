//! What each queued job does. A handler returns the job's output (shown to the
//! client that polls for it) or an error, which the queue retries with backoff.

use serde_json::{Value, json};

use super::{Job, queues};
use crate::models::files::{listing, ops, orphans, trash};
use crate::models::{sessions, shares};
use crate::services::events::types;
use crate::services::onlyoffice::{self as oo, ForceSave};
use crate::services::{cleanup, maintenance};
use crate::state::AppState;

fn strings(data: &Value, field: &str) -> Vec<String> {
    data.get(field)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn text<'a>(data: &'a Value, field: &str) -> Option<&'a str> {
    data.get(field).and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub async fn run(state: &AppState, job: &Job) -> anyhow::Result<Value> {
    match job.queue.as_str() {
        queues::FILE_OPERATIONS => file_operation(state, job).await,
        queues::MAINTENANCE => maintenance_task(state, &job.data).await,
        queues::ORPHANS => orphan_task(state, &job.data).await,
        queues::OBJECT_CLEANUP => {
            let deleted = cleanup::delete_objects(state, &strings(&job.data, "keys")).await?;
            Ok(json!({ "deleted": deleted }))
        }
        queues::SHARE_LINKING => {
            let owner = text(&job.data, "ownerId").ok_or_else(|| anyhow::anyhow!("Missing share-linking ownerId"))?;
            let linked = cleanup::apply_share_linking(state, owner, &strings(&job.data, "itemIds")).await?;
            Ok(json!({ "linked": linked }))
        }
        queues::ONLYOFFICE_FORCESAVE => force_save(state, &job.data).await,
        other => anyhow::bail!("Unknown queue: {other}"),
    }
}

async fn file_operation(state: &AppState, job: &Job) -> anyhow::Result<Value> {
    let data = &job.data;
    let task = text(data, "task").unwrap_or_default();
    if task == "continue-trash-cleanup" {
        return trash_cleanup(state).await;
    }
    let owner = text(data, "userId").ok_or_else(|| anyhow::anyhow!("Missing file-operation userId"))?;
    let ids = strings(data, "ids");
    if task == "copy" {
        let parent = text(data, "parentId");
        let folder_name = text(data, "targetFolderName").unwrap_or("Root");
        let new_ids = ops::copy_items(&state.pool, &state.storage, &ids, parent, owner, Some(job.id)).await?;
        let copied = listing::briefs(&state.pool, &new_ids, owner, false).await?;
        cleanup::link_new_items(state, owner, parent, new_ids.clone()).await;
        let events = copied
            .iter()
            .map(|f| (types::FILE_COPIED, json!({ "id": f.id, "name": f.name, "type": f.item_type, "parentId": parent, "targetFolderName": folder_name, "userId": owner })))
            .collect();
        state.events.publish_batch(owner, events).await;
        return Ok(json!({ "count": new_ids.len(), "ids": new_ids }));
    }
    let (count, event) = match task {
        "trash" => {
            let trashed = trash::trash(&state.pool, &ids, owner).await?;
            shares::forget_tokens(&state.cache, trash::shares_containing(&state.pool, &trashed).await?).await;
            (trashed.len() as i64, types::FILE_DELETED)
        }
        "restore" => (trash::restore(&state.pool, &ids, owner).await?, types::FILE_RESTORED),
        "delete-permanently" => (
            trash::delete_forever(&state.pool, &state.storage, &ids, owner, false).await?,
            types::FILE_PERMANENTLY_DELETED,
        ),
        "empty-trash" => (
            trash::delete_forever(&state.pool, &state.storage, &[], owner, true).await?,
            types::FILE_PERMANENTLY_DELETED,
        ),
        other => anyhow::bail!("Unknown file operation: {other}"),
    };
    state.events.publish_batch(owner, vec![(event, json!({ "userId": owner, "action": task, "count": count }))]).await;
    Ok(json!({ "count": count }))
}

/// One bounded pass of expired-trash cleanup; a backlog continues in a minute.
async fn trash_cleanup(state: &AppState) -> anyhow::Result<Value> {
    let (files, folders, has_more) = trash::cleanup_expired(&state.pool, &state.storage).await?;
    if has_more {
        state.jobs.send(queues::FILE_OPERATIONS, json!({ "task": "continue-trash-cleanup" }), None, 60).await?;
    }
    Ok(json!({ "files": files, "folders": folders, "hasMore": has_more }))
}

async fn maintenance_task(state: &AppState, data: &Value) -> anyhow::Result<Value> {
    let pool = &state.pool;
    Ok(match text(data, "task").unwrap_or_default() {
        "cleanup-expired-trash" => return trash_cleanup(state).await,
        "cleanup-audit-log" => json!({ "deleted": maintenance::cleanup_audit_log(pool).await? }),
        "cleanup-old-sessions" => json!({ "deleted": sessions::cleanup_old(pool).await? }),
        "cleanup-file-operation-results" => json!({ "deleted": maintenance::cleanup_operation_results(pool).await? }),
        "cleanup-bulk-import-manifests" => json!({ "deleted": maintenance::cleanup_import_manifests(pool).await? }),
        "reconcile-folder-aggregates" => {
            let (folders, corrected) = maintenance::reconcile_folder_aggregates(pool).await?;
            json!({ "folders": folders, "corrected": corrected })
        }
        "cleanup-expired-share-links" => json!({ "deleted": shares::cleanup_expired(pool, &state.cache).await? }),
        "cleanup-client-heartbeats" => json!({ "deleted": sessions::purge_stale_heartbeats(pool, 10).await? }),
        "cleanup-storage-reservations" => json!({ "released": maintenance::cleanup_reservations(pool).await? }),
        other => anyhow::bail!("Unknown maintenance task: {other}"),
    })
}

async fn orphan_task(state: &AppState, data: &Value) -> anyhow::Result<Value> {
    let grace = data.get("graceMinutes").and_then(Value::as_i64);
    match text(data, "task").unwrap_or_default() {
        "scan" => Ok(serde_json::to_value(orphans::scan(&state.pool, &state.storage, grace).await?)?),
        "delete" => {
            let report = orphans::delete(
                &state.pool,
                &state.storage,
                &strings(data, "storageKeys"),
                &strings(data, "fileIds"),
                grace,
            )
            .await?;
            Ok(serde_json::to_value(report)?)
        }
        other => anyhow::bail!("Unknown orphan maintenance task: {other}"),
    }
}

/// Once the editor has closed, its schedule is dropped.
async fn force_save(state: &AppState, data: &Value) -> anyhow::Result<Value> {
    let key = text(data, "documentKey").ok_or_else(|| anyhow::anyhow!("Missing documentKey"))?;
    let outcome = match oo::force_save(state, key).await? {
        ForceSave::Saved => "saved",
        ForceSave::NoChanges => "unchanged",
        ForceSave::Closed => {
            oo::unregister_open_document(state, key).await;
            oo::editing::end(state, key).await;
            "closed"
        }
    };
    if outcome != "closed" {
        oo::editing::renew(state, key).await;
    }
    Ok(json!({ "outcome": outcome }))
}
