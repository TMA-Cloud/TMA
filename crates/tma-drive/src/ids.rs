//! A two-way table between the numeric file ids FUSE and NFS speak and the
//! drive's paths. Ids stay stable for the life of a mount and follow renames.

use std::collections::HashMap;

use crate::paths::{self, ROOT};

/// The root folder's id in both FUSE and NFS.
pub const ROOT_ID: u64 = 1;

#[derive(Default)]
pub struct IdTable {
    by_path: HashMap<String, u64>,
    paths: HashMap<u64, String>,
    next: u64,
}

impl IdTable {
    /// The id for `path`, handing out a new one the first time a path is seen.
    pub fn id(&mut self, path: &str) -> u64 {
        if path == ROOT {
            return ROOT_ID;
        }
        let key = paths::key(path);
        if let Some(id) = self.by_path.get(&key) {
            self.paths.insert(*id, path.to_string());
            return *id;
        }
        self.next = self.next.max(ROOT_ID) + 1;
        self.by_path.insert(key, self.next);
        self.paths.insert(self.next, path.to_string());
        self.next
    }

    pub fn path(&self, id: u64) -> Option<String> {
        if id == ROOT_ID { Some(ROOT.to_string()) } else { self.paths.get(&id).cloned() }
    }

    /// Point everything under `from` at `to` after a rename.
    pub fn rename(&mut self, from: &str, to: &str) {
        let moved: Vec<(u64, String)> = self
            .paths
            .iter()
            .filter(|(_, p)| paths::is_at_or_under(p, from))
            .map(|(i, p)| (*i, format!("{to}{}", &p[from.len().min(p.len())..])))
            .collect();
        for (id, path) in moved {
            self.by_path.retain(|_, v| *v != id);
            self.by_path.insert(paths::key(&path), id);
            self.paths.insert(id, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_follow_renames() {
        let mut t = IdTable::default();
        assert_eq!(t.id(ROOT), ROOT_ID);
        let docs = t.id("\\Docs");
        let note = t.id("\\Docs\\note.txt");
        assert_ne!(docs, note);
        // Case-insensitive, like the server's names.
        assert_eq!(t.id("\\docs"), docs);
        t.rename("\\Docs", "\\Papers");
        assert_eq!(t.path(note).as_deref(), Some("\\Papers\\note.txt"));
        assert_eq!(t.id("\\Papers\\note.txt"), note);
        assert_eq!(t.path(999), None);
    }
}
