//! What a save of a local file leaves behind: the version each synced path holds,
//! files sent but not yet marked synced, and refused saves kept as conflicted copies.

use std::path::Path;

use super::local;
use super::worker::{Shared, lock};
use crate::backend::CONFLICT;
use crate::core::Node;
use crate::paths;
use crate::sync_plan::{self, Stamp};

/// How a local file's save went.
pub(super) enum Saved {
    Replaced,
    /// Someone else saved first; the local edit went up as a conflicted copy.
    Conflicted,
}

impl Shared {
    pub(super) fn note_synced(&self, path: &Path, stamp: &Stamp) {
        lock(&self.synced).insert(paths::key(&path.to_string_lossy()), (stamp.id.clone(), stamp.version));
    }

    /// The version a file written over the synced copy of `id` at `path` started from.
    pub(super) fn synced_version(&self, path: &Path, id: &str) -> Option<i64> {
        lock(&self.synced).get(&paths::key(&path.to_string_lossy())).filter(|(sid, _)| sid == id).map(|(_, v)| *v)
    }

    /// Mark a file already on the server synced; false while its app still holds it.
    pub(super) fn mark_sent(&self, path: &Path, key: &str) -> bool {
        let Some((id, version)) = lock(&self.synced).get(key).cloned() else {
            lock(&self.sent).remove(key);
            return true;
        };
        let marked = local::adopt(path, &Stamp { id, version }).is_ok();
        if marked {
            lock(&self.sent).remove(key);
        }
        marked
    }

    /// A file deleted moments ago and now written again at the same path keeps its
    /// server id, and the version it was synced at (a save that deletes and rewrites).
    pub(super) fn take_delete(&self, path: &Path) -> Option<(String, i64)> {
        lock(&self.deletes).remove(&paths::key(&path.to_string_lossy())).map(|(id, version, _, _)| (id, version))
    }

    /// Replace a server file with the local one. If someone else saved after this
    /// copy was synced, the server refuses; the local edit is then uploaded beside
    /// it as a conflicted copy, so neither save is lost.
    pub(super) fn save(
        &self,
        folder: &Node,
        id: &str,
        server_name: &str,
        path: &Path,
        base: Option<i64>,
    ) -> Result<Saved, String> {
        let backend = self.core.backend();
        match backend.replace(id, server_name, path, base) {
            Ok(_) => Ok(Saved::Replaced),
            Err(err) if err == CONFLICT => {
                let when = chrono::Local::now().format("%Y-%m-%d %H%M").to_string();
                let copy = sync_plan::conflict_name(server_name, &when);
                backend.upload(folder.id.as_deref(), &copy, path)?;
                log::warn!(
                    "[drive] {} changed on the server since it was opened; kept this edit as {copy}",
                    path.display()
                );
                Ok(Saved::Conflicted)
            }
            Err(err) => Err(err),
        }
    }
}
