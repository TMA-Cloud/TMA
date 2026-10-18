//! Saving a changed file back to the server. The content version a file had
//! when an app opened it goes with the save; if someone else saved in between,
//! the server refuses, and the save is kept beside the file as a conflicted copy
//! instead of silently overwriting the newer one.

use std::path::Path;

use super::handle::State;
use super::{Core, lock};
use crate::backend::CONFLICT;
use crate::paths;
use crate::sync_plan;

/// Where a save's contents went.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Saved {
    /// Over the file, which is now at this content version.
    Replaced(i64),
    /// Beside it as a conflicted copy with this name: someone else saved first.
    Copy(String),
}

impl Core {
    /// Note the version an app opened a file at; its saves start from it.
    pub(super) fn remember_opened(&self, path: &str, version: i64) {
        if version > 0 {
            lock(&self.opened).insert(paths::key(path), version);
        }
    }

    /// The version the file at `path` was opened at, if an app opened it here.
    pub(super) fn opened_version(&self, path: &str) -> Option<i64> {
        lock(&self.opened).get(&paths::key(path)).copied()
    }

    /// Save `src` over file `id` at `path`, checked against `base`. A refused save is
    /// uploaded into `parent` as a conflicted copy; a saved one moves `path` to the new version.
    pub(super) fn save_over(
        &self,
        path: &str,
        id: &str,
        parent: Option<&str>,
        server_name: &str,
        src: &Path,
        base: Option<i64>,
    ) -> Result<Saved, String> {
        match self.backend.replace(id, server_name, src, base) {
            Ok(version) => {
                self.remember_opened(path, version);
                Ok(Saved::Replaced(version))
            }
            Err(err) if err == CONFLICT => {
                let when = chrono::Local::now().format("%Y-%m-%d %H%M").to_string();
                let copy = sync_plan::conflict_name(server_name, &when);
                self.backend.upload(parent, &copy, src)?;
                log::warn!("{path} changed on the server since it was opened; kept this save as {copy}");
                Ok(Saved::Copy(copy))
            }
            Err(err) => Err(err),
        }
    }

    /// Upload a changed file: over the file it was opened from, checked against
    /// that version, or as a new file (over a same-named one if the app recreated it).
    pub(super) fn upload_back(&self, state: &mut State) -> Result<(), String> {
        let Some(src) = state.local.clone() else { return Ok(()) };
        let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        let name = state.node.name.clone();
        let server_name = self.to_server_name(&name);
        if let (false, Some(id)) = (state.is_new, state.node.id.clone()) {
            let parent_path = paths::parent(&state.node.path).unwrap_or_else(|| paths::ROOT.into());
            let parent = self.resolve(&parent_path).ok().flatten().and_then(|p| p.id);
            let base = sync_plan::base(state.node.version);
            let path = state.node.path.clone();
            if let Saved::Replaced(version) = self.save_over(&path, &id, parent.as_deref(), &server_name, &src, base)? {
                state.node.version = version;
            }
            self.invalidate(&parent_path);
            return Ok(());
        }
        let path = state.node.path.clone();
        let parent_id = state.parent.as_ref().and_then(|p| p.id.clone());
        let _guard = self.path_lock(&path);
        // Replace a file of the same name rather than making a "name (2)" copy.
        let target = match self.created_id(&path) {
            Some(id) => Some((id, true)),
            None => self
                .find_child(parent_id.as_deref(), &name, false)
                .map_err(|e| e.to_string())?
                .map(|e| (e.id, e.size > 0)),
        };
        if let Some((id, has_content)) = target {
            // An empty save never clobbers a file that has content.
            if size == 0 && has_content {
                state.node.id = Some(id);
                state.is_new = false;
                return Ok(());
            }
            // An app that saves by writing a new file still saves from the version it opened.
            match self.save_over(&path, &id, parent_id.as_deref(), &server_name, &src, self.opened_version(&path)) {
                Ok(Saved::Replaced(version)) => {
                    state.node.id = Some(id.clone());
                    state.node.version = version;
                    state.is_new = false;
                    self.track_created(&path, &id);
                    self.invalidate(&paths::parent(&path).unwrap_or_else(|| paths::ROOT.into()));
                    return Ok(());
                }
                Ok(Saved::Copy(_)) => {
                    self.invalidate(&paths::parent(&path).unwrap_or_else(|| paths::ROOT.into()));
                    return Ok(());
                }
                Err(err) => log::warn!("replace failed, uploading as new: {err}"),
            }
        }
        let id = self.backend.upload(parent_id.as_deref(), &server_name, &src)?;
        state.node.id = Some(id.clone());
        state.is_new = false;
        self.track_created(&path, &id);
        self.invalidate(&paths::parent(&path).unwrap_or_else(|| paths::ROOT.into()));
        Ok(())
    }
}
