//! What Windows asks of the sync engine: list a folder being browsed, download
//! a file being opened, and agree to deletes and renames of placeholders.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use cloud_filter::error::{CResult, CloudErrorKind};
use cloud_filter::filter::{Request, SyncFilter, info, ticket};
use cloud_filter::placeholder_file::PlaceholderFile;
use cloud_filter::utility::WriteAt;

use crate::cloud_files::local;
use crate::cloud_files::worker::Shared;
use crate::sync_plan::Stamp;

/// Transfers must be whole 4 KiB pages, except the last one.
const CHUNK: usize = 1024 * 1024;

pub struct Filter {
    pub shared: Arc<Shared>,
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
        if core.deny_read.load(Ordering::Relaxed) {
            return Err(CloudErrorKind::AccessDenied);
        }
        let stamp = Stamp::decode(request.file_blob()).ok_or(CloudErrorKind::InvalidRequest)?;
        log::debug!("[drive] download {}", request.path().display());
        let size = request.file_size();
        let staged = core.new_staging_file();
        let result = (|| {
            core.backend().download(&stamp.id, &staged).map_err(|e| unsuccessful("download", e))?;
            let mut file = std::fs::File::open(&staged).map_err(|e| unsuccessful("staged file", e))?;
            let mut buf = vec![0u8; CHUNK];
            let mut offset = 0u64;
            while offset < size {
                let len = CHUNK.min((size - offset) as usize);
                file.read_exact(&mut buf[..len]).map_err(|e| unsuccessful("server copy is shorter", e))?;
                ticket.write_at(&buf[..len], offset).map_err(|e| unsuccessful("transfer", e))?;
                offset += len as u64;
                let _ = ticket.report_progress(size, offset);
            }
            Ok(())
        })();
        let _ = std::fs::remove_file(&staged);
        result
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
