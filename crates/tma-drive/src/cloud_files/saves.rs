//! What a save of a local file leaves behind: the version each synced path holds,
//! files sent but not yet marked synced, and refused saves kept as conflicted copies.

use std::path::Path;

use super::local;
use super::worker::{Shared, lock};
use crate::backend::{CONFLICT, Entry};
use crate::core::Node;
use crate::paths;
use crate::sync_plan::{self, Local, Stamp};

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

    /// The server file and version `path` last held when it was synced.
    pub(super) fn synced_at(&self, path: &Path) -> Option<(String, i64)> {
        lock(&self.synced).get(&paths::key(&path.to_string_lossy())).cloned()
    }

    /// The server file a new file at `path` saves into, and the version to check, when the
    /// server renamed that file while its program held it (see `sync_plan::renamed_while_open`).
    pub(super) fn renamed_away(&self, path: &Path, local: &[Local], server: &[Entry]) -> Option<(String, Option<i64>)> {
        let (id, version) = self.synced_at(path)?;
        sync_plan::renamed_while_open(local, server, &id).then(|| (id, sync_plan::base(version)))
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
