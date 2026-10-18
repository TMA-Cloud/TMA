//! The edit lock an ONLYOFFICE editing session holds. Every browser open is its
//! own document session (the key carries the open time), so two people editing
//! at once would each save over the other: the first takes the lock and anyone
//! else, in the browser or a desktop app, gets the file read-only until it closes.

use std::time::Duration;

use crate::models::files::locks::{self, Actor, Taken};
use crate::state::AppState;

/// Longer than the desktop's lease: the five-minute force-save tick renews it,
/// and the document server's close callback ends it.
const LEASE: Duration = Duration::from_secs(600);

/// The lock's device for a session: no desktop install id can take this form.
fn device(key: &str) -> String {
    format!("{}{key}", tma_core::api::BROWSER_DEVICE_PREFIX)
}

/// Take the lock for the session `key` opening `file_id` to edit. False when
/// someone else holds the file now; the editor then opens it read-only.
pub async fn hold(state: &AppState, key: &str, file_id: &str, owner: &str, user: &str) -> bool {
    let device = device(key);
    let actor = Actor { user, device: Some(&device) };
    match locks::acquire(&state.pool, file_id, owner, actor, LEASE).await {
        Ok(Some(Taken::Held { .. })) => {
            state.events.lock_changed(owner, file_id).await;
            true
        }
        Ok(_) => false,
        Err(err) => {
            tracing::warn!(error = %err, file_id, "[ONLYOFFICE] Could not lock the file for editing");
            true
        }
    }
}

/// The session is still open (force-save tick, a user joined or left).
pub async fn renew(state: &AppState, key: &str) {
    let Some((_, file_id)) = super::parse_document_key(key) else { return };
    if let Err(err) = locks::renew_device(&state.pool, &file_id, &device(key), LEASE).await {
        tracing::warn!(error = %err, file_id, "[ONLYOFFICE] Could not renew the edit lock");
    }
}

/// The session closed: the file is free again.
pub async fn end(state: &AppState, key: &str) {
    let Some((owner, file_id)) = super::parse_document_key(key) else { return };
    match locks::release_device(&state.pool, &file_id, &device(key)).await {
        Ok(true) => state.events.lock_changed(&owner, &file_id).await,
        Ok(false) => {}
        Err(err) => tracing::warn!(error = %err, file_id, "[ONLYOFFICE] Could not release the edit lock"),
    }
}
