//! What Windows asks of the sync engine: list a folder being browsed, download
//! a file being opened, and agree to deletes and renames of placeholders.

use std::sync::Arc;

use cloud_filter::error::{CResult, CloudErrorKind};
use cloud_filter::filter::{Request, SyncFilter, info, ticket};
use cloud_filter::placeholder_file::PlaceholderFile;
use cloud_filter::utility::WriteAt;

use crate::cloud_files::local;
use crate::cloud_files::worker::Shared;
use crate::sync_plan::Stamp;

/// Transfers must be whole 4 KiB pages, except the last one.
const PAGE: usize = 4096;
const CHUNK: usize = 1024 * 1024;

pub struct Filter {
    pub shared: Arc<Shared>,
}

/// Connected while clearing a folder with the app closed: without a connected
/// engine Windows refuses even to delete placeholders.
pub struct Idle;

impl SyncFilter for Idle {
    fn fetch_data(&self, _request: Request, _ticket: ticket::FetchData, _info: info::FetchData) -> CResult<()> {
        Err(CloudErrorKind::ProviderNotRunning)
    }

    fn delete(&self, _request: Request, ticket: ticket::Delete, _info: info::Delete) -> CResult<()> {
        ticket.pass().map_err(|e| unsuccessful("delete", e))
    }
}

/// Changes the engine makes itself (resyncing) need no server call.
fn ours(request: &Request) -> bool {
    request.process().id() == std::process::id()
}

fn unsuccessful(what: &str, err: impl std::fmt::Display) -> CloudErrorKind {
    log::warn!("[drive] {what}: {err}");
    CloudErrorKind::Unsuccessful
}

impl Filter {
    fn hydrate(&self, request: &Request, ticket: &ticket::FetchData) -> CResult<()> {
        let core = &self.shared.core;
        let path = request.path();
        if !self.shared.rel(&path).is_some_and(|rel| core.may_read(&rel)) {
            log::info!("[drive] save-only: refused to open {}", path.display());
            return Err(CloudErrorKind::AccessDenied);
        }
        let stamp = Stamp::decode(request.file_blob()).ok_or(CloudErrorKind::InvalidRequest)?;
        log::debug!("[drive] download {}", path.display());
        let size = request.file_size();
        // Straight from the server into the placeholder: whole pages, the last one may be short.
        let mut pending: Vec<u8> = Vec::with_capacity(CHUNK);
        let mut offset = 0u64;
        let flush = |pending: &mut Vec<u8>, offset: &mut u64| -> Result<(), String> {
            ticket.write_at(pending, *offset).map_err(|e| format!("transfer: {e}"))?;
            *offset += pending.len() as u64;
            pending.clear();
            let _ = ticket.report_progress(size, *offset);
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

impl SyncFilter for Filter {
    fn fetch_data(&self, request: Request, ticket: ticket::FetchData, _info: info::FetchData) -> CResult<()> {
        self.hydrate(&request, &ticket)
    }

    fn fetch_placeholders(
        &self,
        request: Request,
        ticket: ticket::FetchPlaceholders,
        _info: info::FetchPlaceholders,
    ) -> CResult<()> {
        let rel = self.shared.rel(&request.path()).ok_or(CloudErrorKind::NotUnderSyncRoot)?;
        log::debug!("[drive] list {rel}");
        let core = &self.shared.core;
        let folder = core
            .resolve(&rel)
            .map_err(|e| unsuccessful("resolve", format!("{e:?}")))?
            .filter(|n| n.is_folder)
            .ok_or(CloudErrorKind::InvalidRequest)?;
        let children = core.children(&folder).map_err(|e| unsuccessful("listing", format!("{e:?}")))?;
        let mut placeholders: Vec<PlaceholderFile> =
            children.iter().filter_map(local::entry).map(|e| local::placeholder(&e)).collect();
        ticket.pass_with_placeholder(&mut placeholders).map_err(|e| unsuccessful("placeholders", e))
    }

    fn delete(&self, request: Request, ticket: ticket::Delete, _info: info::Delete) -> CResult<()> {
        log::debug!("[drive] delete {}", request.path().display());
        ticket.pass().map_err(|e| unsuccessful("delete", e))?;
        if !ours(&request)
            && let Some(stamp) = Stamp::decode(request.file_blob())
        {
            self.shared.queue_delete(stamp.id, request.path());
        }
        Ok(())
    }

    fn rename(&self, request: Request, ticket: ticket::Rename, info: info::Rename) -> CResult<()> {
        if ours(&request) {
            return ticket.pass().map_err(|e| unsuccessful("rename", e));
        }
        let from = request.path();
        log::debug!("[drive] rename {} -> {}", from.display(), info.target_path().display());
        if !info.target_in_scope() {
            // Moved out of the drive: it leaves the cloud, as with any synced folder.
            ticket.pass().map_err(|e| unsuccessful("rename", e))?;
            if let Some(stamp) = Stamp::decode(request.file_blob()) {
                self.shared.queue_delete(stamp.id, from);
            }
            return Ok(());
        }
        let to = info.target_path();
        let (Some(from_rel), Some(to_rel)) = (self.shared.rel(&from), self.shared.rel(&to)) else {
            return Err(CloudErrorKind::NotUnderSyncRoot);
        };
        // Refuse the rename if the server cannot follow, so both sides stay the same.
        self.shared
            .core
            .rename(&from_rel, &to_rel)
            .map_err(|e| unsuccessful("rename on the server", format!("{e:?}")))?;
        ticket.pass().map_err(|e| unsuccessful("rename", e))
    }
}
