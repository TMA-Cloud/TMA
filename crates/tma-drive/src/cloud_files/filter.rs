//! What Windows asks of the sync engine: list a folder being browsed, download
//! a file being opened, and agree to deletes and renames of placeholders.

use std::path::Path;
use std::sync::Arc;

use crate::cloud_files::cfapi::{Handler, NewPlaceholder, Refusal, Request};
use crate::cloud_files::local;
use crate::cloud_files::worker::Shared;
use crate::paths;
use crate::sync_plan::{self, Stamp};

/// Transfers must be whole 4 KiB pages, except the last one.
const PAGE: usize = 4096;
const CHUNK: usize = 1024 * 1024;

pub struct Filter {
    pub shared: Arc<Shared>,
}

/// Connected while clearing a folder with the app closed: without a connected
/// engine Windows refuses even to delete placeholders.
pub struct Idle;

impl Handler for Idle {
    fn fetch_data(&self, _request: &Request) -> Result<(), Refusal> {
        Err(Refusal::NotRunning)
    }

    fn fetch_placeholders(&self, _request: &Request) -> Result<(), Refusal> {
        Err(Refusal::NotRunning)
    }

    fn delete(&self, request: &Request) -> Result<(), Refusal> {
        request.allow_delete().map_err(|e| unsuccessful("delete", e))
    }

    fn rename(&self, request: &Request, _target: &Path, _in_scope: bool) -> Result<(), Refusal> {
        request.allow_rename().map_err(|e| unsuccessful("rename", e))
    }
}

/// Changes the engine makes itself (resyncing) need no server call.
fn ours(request: &Request) -> bool {
    request.process_id() == std::process::id()
}

fn unsuccessful(what: &str, err: impl std::fmt::Display) -> Refusal {
    log::warn!("[drive] {what}: {err}");
    Refusal::Unsuccessful
}

impl Filter {
    /// For a save's backup copy (see `sync_plan::is_save_backup`), the drive path of
    /// the document it was renamed from, which the server still has under that name.
    fn backup_of(&self, rel: &str, blob: &[u8]) -> Option<String> {
        let name = paths::leaf(rel);
        if !sync_plan::is_local_only(name) {
            return None;
        }
        let stamp = Stamp::decode(blob)?;
        let core = &self.shared.core;
        let folder = core.resolve(&paths::parent(rel)?).ok().flatten()?;
        let children = core.children(&folder).ok()?;
        children
            .into_iter()
            .find(|n| {
                n.id.as_deref() == Some(stamp.id.as_str()) && paths::key(paths::leaf(&n.path)) != paths::key(name)
            })
            .map(|n| n.path)
    }

    fn hydrate(&self, request: &Request) -> Result<(), Refusal> {
        let core = &self.shared.core;
        let path = request.path();
        let rel = self.shared.rel(path).map(|rel| self.backup_of(&rel, request.identity()).unwrap_or(rel));
        if !rel.is_some_and(|rel| core.may_read(&rel)) {
            log::info!("[drive] save-only: refused to open {}", path.display());
            return Err(Refusal::AccessDenied);
        }
        let stamp = Stamp::decode(request.identity()).ok_or(Refusal::InvalidRequest)?;
        log::debug!("[drive] download {}", path.display());
        let size = request.file_size();
        // Straight from the server into the placeholder: whole pages, the last one may be short.
        let mut pending: Vec<u8> = Vec::with_capacity(CHUNK);
        let mut offset = 0u64;
        let flush = |pending: &mut Vec<u8>, offset: &mut u64| -> Result<(), String> {
            request.write(pending, *offset).map_err(|e| format!("transfer: {e}"))?;
            *offset += pending.len() as u64;
            pending.clear();
            request.progress(size, *offset);
            Ok(())
        };
        let mut sink = |chunk: &[u8]| -> Result<(), String> {
            pending.extend_from_slice(chunk);
            if pending.len() >= CHUNK {
                let whole = pending.len() - pending.len() % PAGE;
                let rest = pending.split_off(whole);
                flush(&mut pending, &mut offset)?;
                pending = rest;
            }
            Ok(())
        };
        core.backend().download_with(&stamp.id, &mut sink).map_err(|e| unsuccessful("download", e))?;
        if !pending.is_empty() {
            flush(&mut pending, &mut offset).map_err(|e| unsuccessful("download", e))?;
        }
        if offset < size {
            return Err(unsuccessful("download", "the server copy is shorter than the file"));
        }
        Ok(())
    }
}

impl Handler for Filter {
    fn fetch_data(&self, request: &Request) -> Result<(), Refusal> {
        self.hydrate(request)
    }

    fn fetch_placeholders(&self, request: &Request) -> Result<(), Refusal> {
        let rel = self.shared.rel(request.path()).ok_or(Refusal::NotUnderSyncRoot)?;
        log::debug!("[drive] list {rel}");
        let core = &self.shared.core;
        let folder = core
            .resolve(&rel)
            .map_err(|e| unsuccessful("resolve", format!("{e:?}")))?
            .filter(|n| n.is_folder)
            .ok_or(Refusal::InvalidRequest)?;
        let children = core.children(&folder).map_err(|e| unsuccessful("listing", format!("{e:?}")))?;
        let placeholders: Vec<NewPlaceholder> =
            children.iter().filter_map(local::entry).filter_map(|e| local::placeholder(&e)).collect();
        request.list(&placeholders).map_err(|e| unsuccessful("placeholders", e))?;
        // Listed now, so server changes in it must reach it, not wait for the next full pass.
        self.shared.note_folder(folder.id.clone(), request.path());
        Ok(())
    }

    fn delete(&self, request: &Request) -> Result<(), Refusal> {
        log::debug!("[drive] delete {}", request.path().display());
        request.allow_delete().map_err(|e| unsuccessful("delete", e))?;
        if !ours(request)
            && let Some(stamp) = Stamp::decode(request.identity())
        {
            // A save's backup goes once the new copy is written; the server file is that copy.
            let backup = self.shared.rel(request.path()).and_then(|rel| self.backup_of(&rel, request.identity()));
            if backup.is_none() {
                self.shared.queue_delete(stamp.id, stamp.version, request.path().to_path_buf());
            }
        }
        Ok(())
    }

    fn rename(&self, request: &Request, to: &Path, in_scope: bool) -> Result<(), Refusal> {
        if ours(request) {
            return request.allow_rename().map_err(|e| unsuccessful("rename", e));
        }
        let from = request.path();
        log::debug!("[drive] rename {} -> {}", from.display(), to.display());
        if !in_scope {
            // Moved out of the drive: it leaves the cloud, as with any synced folder.
            request.allow_rename().map_err(|e| unsuccessful("rename", e))?;
            if let Some(stamp) = Stamp::decode(request.identity()) {
                self.shared.queue_delete(stamp.id, stamp.version, from.to_path_buf());
            }
            return Ok(());
        }
        let (Some(from_rel), Some(to_rel)) = (self.shared.rel(from), self.shared.rel(to)) else {
            return Err(Refusal::NotUnderSyncRoot);
        };
        let same_folder =
            paths::parent(&from_rel).map(|p| paths::key(&p)) == paths::parent(&to_rel).map(|p| paths::key(&p));
        let mut server_from = from_rel.clone();
        if let Some(original) = self.backup_of(&from_rel, request.identity()) {
            // A backup put back (the save failed) or moved to another scratch name: nothing changes on the server.
            if paths::key(&original) == paths::key(&to_rel) || sync_plan::is_local_only(paths::leaf(&to_rel)) {
                return request.allow_rename().map_err(|e| unsuccessful("rename", e));
            }
            server_from = original;
        } else if same_folder
            && !from.is_dir()
            && sync_plan::is_save_backup(paths::leaf(&from_rel), paths::leaf(&to_rel))
        {
            log::debug!("[drive] save backup {from_rel} -> {to_rel} stays local");
            return request.allow_rename().map_err(|e| unsuccessful("rename", e));
        }
        // Refuse the rename if the server cannot follow, so both sides stay the same.
        self.shared
            .core
            .rename(&server_from, &to_rel)
            .map_err(|e| unsuccessful("rename on the server", format!("{e:?}")))?;
        request.allow_rename().map_err(|e| unsuccessful("rename", e))
    }
}
