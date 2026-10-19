//! Following the server's change feed: after an event, or a minute without one,
//! ask which folders changed and re-list only those this computer has open,
//! instead of every open folder. Re-listing all of them after each event made
//! a busy account's desktop apps send thousands of listings a minute.

use std::path::{Path, PathBuf};

use super::worker::Shared;
use crate::backend::NO_FEED;

/// What catching up found.
pub(super) enum Feed {
    /// Done: the changed folders open here were re-listed.
    Done,
    /// The server wants a full resync (no cursor yet, or too much changed).
    Full,
    /// The server keeps no feed; resync everything, as before it did.
    Unavailable,
    /// The server could not be asked; try again at the next check.
    Failed,
}

impl Shared {
    /// Remember which open folder has which server id, so a change names it.
    pub(super) fn note_folder(&self, id: Option<String>, dir: &Path) {
        super::worker::lock(&self.open_folders).insert(id, dir.to_path_buf());
    }

    /// Re-list every open folder, taking a cursor first so a change made during
    /// the pass is still reported after it.
    pub(super) fn full_resync(&self) {
        let cursor = self.core.backend().changes(None).ok().map(|c| c.cursor);
        *super::worker::lock(&self.cursor) = cursor;
        self.resync_all();
    }

    pub(super) fn catch_up(&self) -> Feed {
        let cursor = super::worker::lock(&self.cursor).clone();
        let Some(cursor) = cursor else { return Feed::Full };
        let changes = match self.core.backend().changes(Some(&cursor)) {
            Ok(changes) => changes,
            Err(err) if err == NO_FEED => return Feed::Unavailable,
            Err(err) => {
                log::debug!("[drive] could not ask what changed: {err}");
                return Feed::Failed;
            }
        };
        if changes.reset {
            return Feed::Full;
        }
        let dirs: Vec<PathBuf> = {
            let open = super::worker::lock(&self.open_folders);
            changes.folders.iter().filter_map(|id| open.get(id).cloned()).collect()
        };
        for dir in dirs {
            if let Some(rel) = self.rel(&dir) {
                self.core.invalidate(&rel);
            }
            if self.folder(&dir).is_none() {
                // Moved or deleted: its parent's resync takes care of it.
                super::worker::lock(&self.open_folders).retain(|_, d| d != &dir);
                continue;
            }
            self.resync_folder(&dir);
        }
        *super::worker::lock(&self.cursor) = Some(changes.cursor);
        Feed::Done
    }
}
