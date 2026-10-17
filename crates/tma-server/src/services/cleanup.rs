//! Work handed to the worker so no request waits on it: deleting objects that
//! no row references, and linking new items into their folder's shares.

use serde_json::json;

use crate::jobs::queues;
use crate::models::shares;
use crate::state::AppState;

/// Queue deletion of objects nothing points at; deletes inline if the queue is unreachable.
pub async fn enqueue_object_cleanup(state: &AppState, keys: Vec<String>, reason: &str) {
    let mut keys: Vec<String> = keys.into_iter().filter(|k| !k.is_empty()).collect();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        return;
    }
    if let Err(err) = state.jobs.send(queues::OBJECT_CLEANUP, json!({ "keys": keys, "reason": reason }), None, 0).await
    {
        tracing::warn!(error = %err, reason, "Object cleanup queue unavailable; deleting inline");
        if let Err(err) = state.storage.delete_many(&keys).await {
            tracing::warn!(error = %err, count = keys.len(), "Inline object cleanup failed");
        }
    }
}

/// Run one cleanup job in bounded batches; fails (and retries) on any error.
pub async fn delete_objects(state: &AppState, keys: &[String]) -> anyhow::Result<usize> {
    let mut deleted = 0;
    for chunk in keys.chunks(1000) {
        let errors = state.storage.delete_many(chunk).await?;
        if !errors.is_empty() {
            anyhow::bail!("{} object cleanup deletion(s) failed", errors.len());
        }
        deleted += chunk.len();
    }
    Ok(deleted)
}

/// Link new items into every share their parent folder belongs to. The common
/// case (parent not shared) costs one indexed lookup; the subtree write is a job.
pub async fn link_new_items(state: &AppState, owner: &str, parent: Option<&str>, item_ids: Vec<String>) {
    let Some(parent) = parent else { return };
    if item_ids.is_empty() {
        return;
    }
    match shares::parent_has_shares(&state.pool, parent, owner).await {
        Ok(false) => {}
        Ok(true) => {
            let data = json!({ "ownerId": owner, "parentId": parent, "itemIds": item_ids });
            if let Err(err) = state.jobs.send(queues::SHARE_LINKING, data, Some(owner), 0).await {
                tracing::warn!(error = %err, "Share-link queue unavailable; linking inline");
                if let Err(err) = apply_share_linking(state, owner, &item_ids).await {
                    tracing::warn!(error = %err, "Failed to auto-link new items to parent share");
                }
            }
        }
        Err(err) => tracing::warn!(error = %err, "Failed to check parent shares"),
    }
}

/// One share-linking job; idempotent.
pub async fn apply_share_linking(state: &AppState, owner: &str, item_ids: &[String]) -> anyhow::Result<usize> {
    let mappings = shares::link_to_parent_shares(&state.pool, item_ids, owner).await?;
    let mut tokens: Vec<&String> = mappings.iter().map(|(_, s)| s).collect();
    tokens.sort();
    tokens.dedup();
    shares::forget_tokens(&state.cache, tokens).await;
    Ok(mappings.len())
}
