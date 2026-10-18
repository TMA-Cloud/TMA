//! Edit locks in the drive folder: a document an app opens here is locked on
//! the server while it stays open, and one someone else is editing is
//! read-only here, so Office opens it read-only instead of saving over theirs.

use std::path::Path;

use super::local;
use super::worker::Shared;
use crate::backend::Entry;
use crate::editing;
use crate::sync_plan::Local;

impl Shared {
    /// Lock the documents an app has open in `dir`; with `release`, free those it closed.
    pub(super) fn settle_edits(&self, dir: &Path, release: bool) {
        let Some(rel) = self.rel(dir) else { return };
        let Ok(items) = std::fs::read_dir(dir) else { return };
        let names: Vec<String> = items.flatten().filter_map(|i| i.file_name().into_string().ok()).collect();
        let edited = editing::edited(&names);
        let mut open = Vec::new();
        if !edited.is_empty() {
            let Some(server) = self.folder(dir).and_then(|node| self.server(&node)) else { return };
            for name in edited {
                let server_name = self.core.to_server_name(&name);
                if let Some(entry) = server.iter().find(|e| !e.is_folder && e.name.eq_ignore_ascii_case(&server_name)) {
                    open.push((entry.id.clone(), name));
                }
            }
        }
        for (name, editor) in self.core.leases().settle(&rel, &open, release) {
            log::warn!("[drive] {name} is open here while {editor} is editing it; saves stay theirs");
        }
    }

    /// Make synced files someone else is editing read-only, and writable again once they close them.
    pub(super) fn mark_editors(&self, dir: &Path, items: &[Local], server: &[Entry]) {
        for item in items.iter().filter(|i| !i.is_dir && i.in_sync) {
            let Some(entry) = item.stamp.as_ref().and_then(|s| server.iter().find(|e| e.id == s.id)) else { continue };
            let path = dir.join(&item.name);
            let read_only = std::fs::metadata(&path).map(|m| m.permissions().readonly()).unwrap_or(false);
            if read_only != entry.editor.is_some()
                && let Err(err) = local::mark_editor(&path, entry)
            {
                // Open in an app right now: the next resync tries again.
                log::debug!("[drive] could not mark {} for {:?}: {err}", path.display(), entry.editor);
            }
        }
    }
}
