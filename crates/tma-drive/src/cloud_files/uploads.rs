//! Sending one folder's local changes: new files and folders, edits saved over
//! synced files (checked against the version they started from), and restamping
//! what went up so the next save builds on it.

use std::path::{Path, PathBuf};

use crate::cloud_files::local;
use crate::cloud_files::saves::Saved;
use crate::cloud_files::worker::{Shared, lock};
use crate::paths;
use crate::sync_plan::{self, Stamp, Upload};

impl Shared {
    /// Upload what changed in one folder. Returns false to retry later.
    pub(super) fn upload_folder(&self, dir: &Path) -> bool {
        let Ok(folder) = local::read(dir) else { return true };
        let Some(node) = self.folder(dir) else {
            // The folder itself is new: its parent uploads it first.
            if let Some(parent) = dir.parent().filter(|p| self.rel(p).is_some()) {
                self.changed(parent.to_path_buf());
            }
            return true;
        };
        let Some(server) = self.server(&node) else { return false };
        let mut done = true;
        // Files sent but still held by the app that saved them (Excel keeps a workbook open).
        let mut held: Vec<PathBuf> = Vec::new();
        let mut uploaded: Vec<(PathBuf, String, local::Snapshot)> = Vec::new();
        let mut conflicted: Vec<(PathBuf, String, local::Snapshot)> = Vec::new();
        let mut repaired = false;
        for step in sync_plan::uploads(&folder.items, &server) {
            log::debug!("[drive] upload in {}: {step:?}", dir.display());
            let name = match &step {
                Upload::File { name, .. } | Upload::Folder { name, .. } | Upload::Changed { name, .. } => name.clone(),
            };
            if folder.busy.contains(&name) {
                done = false;
                continue;
            }
            let path = dir.join(&name);
            let server_name = self.core.to_server_name(&name);
            let before = local::snapshot(&path);
            let key = paths::key(&path.to_string_lossy());
            if lock(&self.kept).get(&key) == Some(&before) {
                continue;
            }
            // Sent unchanged before: sending it again would only bump its version.
            if lock(&self.sent).get(&key) == Some(&before) {
                if !self.mark_sent(&path, &key) {
                    held.push(path);
                }
                continue;
            }
            // Not an edit: as synced, it is refreshed from the server like any other copy.
            if matches!(step, Upload::Changed { .. }) && local::unchanged_read_only(&path) {
                match local::mark_in_sync(&path) {
                    Ok(()) => repaired = true,
                    Err(err) => {
                        log::warn!("[drive] could not mark {} synced: {err}", path.display());
                        done = false;
                    }
                }
                continue;
            }
            let backend = self.core.backend();
            // A new file over a same-named server one replaces it as asked; a rewrite keeps its version check.
            let target = match &step {
                Upload::File { replace, .. } => {
                    let deleted = self.take_delete(&path).map(|(id, v)| (id, sync_plan::base(v)));
                    // Over a server file of the same name: checked if it replaced that file's synced copy.
                    deleted
                        .or_else(|| {
                            replace.clone().map(|id| {
                                let base = self.synced_version(&path, &id).and_then(sync_plan::base);
                                (id, base)
                            })
                        })
                        // A save under the name the server renamed away is still that file, not a new one.
                        .or_else(|| self.renamed_away(&path, &folder.items, &server))
                }
                // An earlier upload of this file that could not restamp it moved the version on.
                Upload::Changed { id, base, .. } => {
                    let synced = self.synced_version(&path, id).unwrap_or(*base);
                    Some((id.clone(), sync_plan::base(synced.max(*base))))
                }
                Upload::Folder { .. } => None,
            };
            if let Some((id, base)) = target {
                match self.save(&node, &id, &server_name, &path, base) {
                    Ok(Saved::Replaced) => uploaded.push((path, id, before)),
                    Ok(Saved::Conflicted) => {
                        lock(&self.kept).insert(paths::key(&path.to_string_lossy()), before);
                        conflicted.push((path, id, before));
                    }
                    Err(err) => {
                        log::warn!("[drive] upload of {} failed: {err}", path.display());
                        done = false;
                    }
                }
                continue;
            }
            let result = match step {
                Upload::File { .. } | Upload::Changed { .. } => backend.upload(node.id.as_deref(), &server_name, &path),
                Upload::Folder { existing, .. } => {
                    let made = existing.map(Ok).unwrap_or_else(|| backend.mkdir(node.id.as_deref(), &server_name));
                    match made.and_then(|id| local::adopt(&path, &Stamp { id, version: 0 }).map_err(|e| e.to_string()))
                    {
                        Ok(()) => {
                            // A resync must not see the old listing and remove the new folder.
                            self.core.invalidate(&node.path);
                            // Only now may it hold placeholders: bring in what the server has there.
                            self.resync_folder(&path);
                            self.changed(path);
                            continue;
                        }
                        Err(err) => Err(err),
                    }
                }
            };
            match result {
                Ok(id) => uploaded.push((path, id, before)),
                Err(err) => {
                    log::warn!("[drive] upload of {} failed: {err}", path.display());
                    done = false;
                }
            }
        }
        if !uploaded.is_empty() || !conflicted.is_empty() {
            self.core.invalidate(&node.path);
            let server = self.server(&node).unwrap_or_default();
            // The edit is safe in its copy: the original goes back to the server's version.
            for (path, id, before) in conflicted {
                let current = server.iter().find(|e| e.id == id);
                let reverted =
                    local::snapshot(&path) == before && current.is_some_and(|e| local::revert(&path, e).is_ok());
                done &= reverted;
            }
            for (path, id, before) in uploaded {
                let found = server.iter().find(|e| e.id == id).map(Stamp::of);
                // The server holds this content now; the next save of the file builds on it.
                if let Some(stamp) = &found {
                    self.note_synced(&path, stamp);
                }
                // Edited again while uploading: leave it unsynced so the next pass sends it.
                if local::snapshot(&path) != before {
                    done = false;
                    continue;
                }
                let stamp = found.unwrap_or(Stamp { id, version: 0 });
                if let Err(err) = local::adopt(&path, &stamp) {
                    log::debug!("[drive] {} stays unmarked while an app holds it: {err}", path.display());
                    lock(&self.sent).insert(paths::key(&path.to_string_lossy()), before);
                    held.push(path);
                }
            }
        }
        if repaired {
            // Bring the repaired copies up to the server's version now.
            self.core.invalidate(&node.path);
            self.resync_folder(dir);
        }
        // Waiting only for apps to let go: later passes check that here, not on the server.
        if done && !held.is_empty() {
            lock(&self.waiting).insert(dir.to_path_buf(), held);
            return false;
        }
        lock(&self.waiting).remove(dir);
        done
    }

    /// Whether `dir` still waits only for apps to let go of files it sent. Those let go
    /// are marked synced without listing the folder; one changed since needs a full pass.
    pub(super) fn still_held(&self, dir: &Path) -> bool {
        let Some(mut held) = lock(&self.waiting).remove(dir) else { return false };
        for path in &held {
            if lock(&self.sent).get(&paths::key(&path.to_string_lossy())) != Some(&local::snapshot(path)) {
                return false;
            }
        }
        held.retain(|path| !self.mark_sent(path, &paths::key(&path.to_string_lossy())));
        if held.is_empty() {
            return false;
        }
        lock(&self.waiting).insert(dir.to_path_buf(), held);
        true
    }
}
