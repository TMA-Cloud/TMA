//! Edit locks in the drive folder: a document an app opens here is locked on
//! the server while it stays open, and one someone else is editing is
//! read-only here, so Office opens it read-only instead of saving over theirs.

use std::path::{Path, PathBuf};

use super::local;
use super::worker::{Shared, lock};
use crate::backend::Entry;
use crate::editing;
use crate::sync_plan::Local;

/// Whether a program holds open a workbook in `dir` that leaves no owner file.
fn holds_open_workbook(dir: &Path) -> bool {
    let Ok(items) = std::fs::read_dir(dir) else { return false };
    items
        .flatten()
        .any(|item| item.file_name().to_str().is_some_and(editing::open_by_handle) && local::held_open(&item.path()))
}

impl Shared {
    /// Lock the documents an app has open in `dir`; with `release`, free those it closed.
    pub(super) fn settle_edits(&self, dir: &Path, release: bool) {
        let Some(rel) = self.rel(dir) else { return };
        let Ok(items) = std::fs::read_dir(dir) else { return };
        let names: Vec<String> = items.flatten().filter_map(|i| i.file_name().into_string().ok()).collect();
        let mut edited = editing::edited(&names);
        // Formats without owner files show they are open by the handle their program keeps.
        edited.extend(names.iter().filter(|n| editing::open_by_handle(n) && local::held_open(&dir.join(n))).cloned());
        let mut open = Vec::new();
        if !edited.is_empty() {
            let Some(server) = self.folder(dir).and_then(|node| self.server(&node)) else { return };
            for name in edited {
                let server_name = self.core.to_server_name(&name);
                let by_name = server.iter().find(|e| !e.is_folder && e.name.eq_ignore_ascii_case(&server_name));
                // Renamed on the server while open: the old name here is still that file.
                let id = by_name.map(|e| e.id.clone()).or_else(|| {
                    let (id, _) = self.synced_at(&dir.join(&name))?;
                    server.iter().any(|e| e.id == id && !e.is_folder).then_some(id)
                });
                if let Some(id) = id {
                    open.push((id, name));
                }
            }
        }
        for (name, editor) in self.core.leases().settle(&rel, &open, release) {
            log::warn!("[drive] {name} is open here while {editor} is editing it; saves stay theirs");
        }
    }

    /// Look again at folders with documents locked from here, and at open folders for
    /// workbooks a program holds without an owner file. Neither shows in the folder:
    /// Windows reports an in-place write only when its program lets go, and Excel can
    /// close an unchanged workbook without touching it, so no change would say so.
    pub(super) fn recheck_edits(&self) {
        let mut dirs: Vec<PathBuf> = self
            .core
            .leases()
            .folders()
            .iter()
            .map(|rel| rel.split('\\').filter(|p| !p.is_empty()).fold(self.root.clone(), |dir, part| dir.join(part)))
            .collect();
        let open: Vec<PathBuf> = lock(&self.open_folders).values().cloned().collect();
        dirs.extend(open.into_iter().filter(|dir| holds_open_workbook(dir)));
        dirs.sort();
        dirs.dedup();
        for dir in dirs {
            self.settle_edits(&dir, !self.is_dirty(&dir));
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
