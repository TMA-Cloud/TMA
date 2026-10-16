//! Scratch files apps keep beside a document while saving: Office's backup and
//! temporary copies, LibreOffice's `lu*.tmp`, lock files (see
//! `sync_plan::is_local_only`). They exist only here, so a save never uploads
//! them, and the new copy replaces the document on the server under its id.
//!
//! Word renames the document to a backup name, writes the new copy, renames it
//! over the document's name and deletes the backup. The first rename only hides
//! the server file here; the second replaces its contents.

use std::path::PathBuf;

use chrono::{DateTime, Utc};

use super::{Core, FsError, FsResult, Node, lock};
use crate::{paths, sync_plan};

#[derive(Debug, Clone)]
pub(super) struct Scratch {
    pub path: String,
    /// The local contents, once something wrote or read them.
    pub staging: Option<PathBuf>,
    /// The server file this is a backup of; its contents until `staging` holds them.
    pub backup_of: Option<String>,
    pub size: u64,
    pub modified: DateTime<Utc>,
}

pub(super) fn is_scratch_name(path: &str) -> bool {
    sync_plan::is_local_only(paths::leaf(path))
}

fn parent_of(path: &str) -> String {
    paths::parent(path).unwrap_or_else(|| paths::ROOT.into())
}

impl Core {
    pub(super) fn scratch(&self, path: &str) -> Option<Scratch> {
        lock(&self.scratch).get(&paths::key(path)).cloned()
    }

    /// A new scratch file, replacing any scratch file already at `path`.
    pub(super) fn add_scratch(&self, path: &str, staging: PathBuf) {
        let old = lock(&self.scratch).insert(
            paths::key(path),
            Scratch { path: path.to_string(), staging: Some(staging), backup_of: None, size: 0, modified: Utc::now() },
        );
        if let Some(old) = old.and_then(|s| s.staging) {
            let _ = std::fs::remove_file(old);
        }
        self.invalidate(&parent_of(path));
    }

    /// Where a scratch file's contents now live (after a first read or write).
    pub(super) fn keep_scratch(&self, path: &str, staging: PathBuf) {
        if let Some(s) = lock(&self.scratch).get_mut(&paths::key(path)) {
            s.staging = Some(staging);
            s.modified = Utc::now();
        }
    }

    /// Whether a server file is hidden because an app renamed it to a backup name.
    pub(super) fn is_hidden(&self, path: &str) -> bool {
        lock(&self.hidden).contains_key(&paths::key(path))
    }

    /// The scratch files in a folder, listed beside its server items.
    pub(super) fn scratch_nodes(&self, folder: &str) -> Vec<Node> {
        let folder = paths::key(folder);
        lock(&self.scratch)
            .values()
            .filter(|s| paths::parent(&s.path).map(|p| paths::key(&p)) == Some(folder.clone()))
            .map(|s| Node {
                id: None,
                name: paths::leaf(&s.path).to_string(),
                is_folder: false,
                size: s.staging.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(s.size),
                modified: s.modified,
                accessed: None,
                path: s.path.clone(),
            })
            .collect()
    }

    /// A document renamed to a backup name: the server keeps it as it is.
    pub(super) fn stash_backup(&self, node: &Node, id: &str, to: &str) {
        lock(&self.hidden).insert(paths::key(&node.path), (id.to_string(), node.path.clone()));
        lock(&self.created).remove(&paths::key(&node.path));
        let backup = Scratch {
            path: to.to_string(),
            staging: None,
            backup_of: Some(id.to_string()),
            size: node.size,
            modified: node.modified,
        };
        lock(&self.scratch).insert(paths::key(to), backup);
        self.invalidate(&parent_of(&node.path));
        self.invalidate(&parent_of(to));
    }

    /// Where the document a backup was made from is hidden, if it still is.
    fn hidden_original(&self, id: &str) -> Option<String> {
        lock(&self.hidden).values().find(|(hid, _)| hid == id).map(|(_, path)| path.clone())
    }

    fn unhide(&self, path: &str) -> Option<String> {
        lock(&self.hidden).remove(&paths::key(path)).map(|(id, _)| id)
    }

    /// A scratch file deleted. A backup deleted while its document is still
    /// hidden was a real file renamed by hand, so that file is deleted for good.
    pub(super) fn delete_scratch(&self, path: &str) {
        let Some(s) = lock(&self.scratch).remove(&paths::key(path)) else { return };
        if let Some(staging) = &s.staging {
            let _ = std::fs::remove_file(staging);
        }
        if let Some(id) = &s.backup_of
            && let Some(original) = self.hidden_original(id)
        {
            self.unhide(&original);
            if let Err(err) = self.backend.delete(id) {
                log::warn!("delete failed: {err}");
            }
            self.invalidate(&parent_of(&original));
        }
        self.invalidate(&parent_of(path));
    }

    /// Rename a scratch file: to another scratch name it stays local; onto a
    /// real name it becomes that file, replacing the server copy under its id.
    pub(super) fn rename_scratch(&self, from: &str, to: &str) -> FsResult<()> {
        let Some(mut s) = lock(&self.scratch).remove(&paths::key(from)) else { return Err(FsError::NotFound) };
        self.invalidate(&parent_of(from));
        self.invalidate(&parent_of(to));
        if is_scratch_name(to) {
            if let Some(old) = lock(&self.scratch).remove(&paths::key(to)).and_then(|o| o.staging) {
                let _ = std::fs::remove_file(old);
            }
            s.path = to.to_string();
            lock(&self.scratch).insert(paths::key(to), s);
            return Ok(());
        }
        let restore = |s: Scratch| {
            lock(&self.scratch).insert(paths::key(from), s);
        };
        let Some(staging) = s.staging.clone() else {
            // Never read or written: a backup put back, moved elsewhere, or an empty file.
            let Some(id) = s.backup_of.clone() else {
                self.track_empty(to);
                return Ok(());
            };
            let Some(original) = self.hidden_original(&id) else {
                restore(s);
                return Err(FsError::AccessDenied);
            };
            self.unhide(&original);
            if paths::key(&original) == paths::key(to) {
                return Ok(());
            }
            return self.rename(&original, to).inspect_err(|_| {
                lock(&self.hidden).insert(paths::key(&original), (id.clone(), original.clone()));
                restore(s.clone());
            });
        };
        match self.upload_scratch(&staging, to) {
            Ok(()) => {
                let _ = std::fs::remove_file(&staging);
                Ok(())
            }
            Err(err) => {
                log::warn!("upload failed for {to}: {err}");
                restore(s);
                Err(FsError::AccessDenied)
            }
        }
    }

    /// Put a scratch file's contents at `to`: over the file there (or the one an app
    /// hid by renaming it to a backup name), keeping its id, or as a new file.
    fn upload_scratch(&self, staging: &std::path::Path, to: &str) -> Result<(), String> {
        let name = paths::leaf(to).to_string();
        let server_name = self.to_server_name(&name);
        let parent = self.resolve(&parent_of(to)).map_err(|e| e.to_string())?.filter(|p| p.is_folder);
        let parent = parent.ok_or("the folder is gone")?;
        let _guard = self.path_lock(to);
        let target = match self.unhide(to).or_else(|| self.created_id(to)) {
            Some(id) => Some(id),
            None => self.find_child(parent.id.as_deref(), &name, false).map_err(|e| e.to_string())?.map(|e| e.id),
        };
        let id = match target {
            Some(id) => {
                self.backend.replace(&id, &server_name, staging)?;
                id
            }
            None => self.backend.upload(parent.id.as_deref(), &server_name, staging)?,
        };
        self.untrack_empty(to);
        self.track_created(to, &id);
        self.invalidate(&parent.path);
        Ok(())
    }
}
