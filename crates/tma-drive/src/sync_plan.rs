//! What the Cloud Files adapter changes in a local folder so it matches the
//! server, and what it uploads. Pure, so it is tested on every platform.

use std::collections::{HashMap, HashSet};

use crate::backend::Entry;

/// One item in a local folder of the sync root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Local {
    pub name: String,
    pub is_dir: bool,
    /// The server identity stored in a placeholder; `None` for an item made here.
    pub stamp: Option<Stamp>,
    /// Whether a placeholder still matches what was last synced.
    pub in_sync: bool,
}

/// What a placeholder remembers about the server copy it stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub id: String,
    /// The server's content version when this copy was synced.
    pub version: i64,
}

impl Stamp {
    /// The identity of a placeholder that no longer stands for a server item.
    pub const UNSTAMPED: &[u8] = b"
";

    pub fn of(entry: &Entry) -> Self {
        Self { id: entry.id.clone(), version: entry.version }
    }

    /// Stored as the placeholder's blob: "id\nversion".
    pub fn encode(&self) -> Vec<u8> {
        format!("{}\n{}", self.id, self.version).into_bytes()
    }

    pub fn decode(blob: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(blob).ok()?;
        let (id, version) = text.split_once('\n').unwrap_or((text, "0"));
        (!id.is_empty()).then(|| Self { id: id.to_string(), version: version.parse().unwrap_or(0) })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fix {
    /// On the server but not here: add a placeholder.
    Create(Entry),
    /// Changed on the server: refresh the placeholder and drop the stale contents.
    Update { name: String, entry: Entry },
    /// Renamed on the server.
    Rename { from: String, entry: Entry },
    /// Gone from the server (deleted or moved elsewhere).
    Remove(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Upload {
    /// A file made here; `replace` is the server file of the same name it overwrites.
    File { name: String, replace: Option<String> },
    /// A folder made here; `existing` is a server folder of the same name to adopt.
    Folder { name: String, existing: Option<String> },
    /// A placeholder edited here, from the server copy at content version `base`.
    Changed { name: String, id: String, base: i64 },
}

/// The version to send with a save; 0 means the copy predates versions, so the save is not checked.
pub fn base(version: i64) -> Option<i64> {
    (version > 0).then_some(version)
}

/// The name a refused save is kept under, beside the file: "Report (conflicted copy
/// 2026-10-15 1946).xlsx", as OneDrive and Dropbox name theirs.
pub fn conflict_name(name: &str, when: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    format!("{stem} (conflicted copy {when}){ext}")
}

/// Lock and scratch files apps keep beside a document; never uploaded.
pub fn is_local_only(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with("~$")
        || lower.starts_with(".~lock.")
        || lower.ends_with(".tmp")
        || is_excel_scratch(name)
        || matches!(lower.as_str(), "desktop.ini" | "thumbs.db" | ".ds_store")
}

/// Excel saves through files named with eight uppercase hex digits and no extension.
fn is_excel_scratch(name: &str) -> bool {
    name.len() == 8 && name.bytes().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

/// Word and Excel save by renaming the document to a scratch name as a backup,
/// writing the new copy under the real name, then deleting the backup. That
/// rename stays local, so the server file keeps its name and id for the new copy.
pub fn is_save_backup(from: &str, to: &str) -> bool {
    !is_local_only(from) && is_local_only(to)
}

fn key(name: &str) -> String {
    name.to_lowercase()
}

/// The item here that stands for server item `id`, not counting an editor's scratch
/// copies. A file the server renamed keeps its old name here while a program holds it.
pub fn holding<'a>(local: &'a [Local], id: &str) -> Option<&'a Local> {
    local.iter().find(|l| !is_local_only(&l.name) && l.stamp.as_ref().is_some_and(|s| s.id == id))
}

/// Whether the item here named `name` stands for server item `id`.
fn stands_for(local: &[Local], name: &str, id: &str) -> bool {
    local.iter().any(|l| key(&l.name) == key(name) && l.stamp.as_ref().is_some_and(|s| s.id == id))
}

/// Whether a new file, last synced here as server file `id`, is a save of that file.
/// The server renamed it while a program held it open, so the program saved under the
/// old name; it is still that file as long as the server has it and nothing else here does.
pub fn renamed_while_open(local: &[Local], server: &[Entry], id: &str) -> bool {
    server.iter().any(|e| e.id == id && !e.is_folder) && holding(local, id).is_none()
}

fn same_type(local: &Local, entry: &Entry) -> bool {
    local.is_dir == entry.is_folder
}

/// The local changes that bring a folder in line with the server listing.
/// Items made or edited here are never removed or overwritten.
pub fn reconcile(local: &[Local], server: &[Entry]) -> Vec<Fix> {
    let by_id: HashMap<&str, &Entry> = server.iter().map(|e| (e.id.as_str(), e)).collect();
    let local_names: HashSet<String> = local.iter().map(|l| key(&l.name)).collect();
    let mut claimed: HashSet<&str> = HashSet::new();
    let mut fixes = Vec::new();
    for item in local {
        let Some(stamp) = &item.stamp else { continue };
        match by_id.get(stamp.id.as_str()) {
            Some(entry) if same_type(item, entry) => {
                claimed.insert(entry.id.as_str());
                // A save's backup copy: renaming it back would undo the app's save.
                if entry.name != item.name && is_local_only(&item.name) {
                    continue;
                }
                if entry.name != item.name {
                    let free = key(&entry.name) == key(&item.name) || !local_names.contains(&key(&entry.name));
                    if free {
                        fixes.push(Fix::Rename { from: item.name.clone(), entry: (*entry).clone() });
                    } else if !item.is_dir && item.in_sync && stands_for(local, &entry.name, &entry.id) {
                        // A save under the old name, made while the server renamed the file:
                        // the copy under the new name holds the same contents now.
                        fixes.push(Fix::Remove(item.name.clone()));
                    }
                } else if !item.is_dir && item.in_sync && stamp.version != entry.version {
                    fixes.push(Fix::Update { name: item.name.clone(), entry: (*entry).clone() });
                }
            }
            _ if item.is_dir || item.in_sync => fixes.push(Fix::Remove(item.name.clone())),
            _ => {}
        }
    }
    let removed: HashSet<String> =
        fixes.iter().filter_map(|f| if let Fix::Remove(n) = f { Some(key(n)) } else { None }).collect();
    for entry in server {
        let taken = local_names.contains(&key(&entry.name)) && !removed.contains(&key(&entry.name));
        if !claimed.contains(entry.id.as_str()) && !taken {
            fixes.push(Fix::Create(entry.clone()));
        }
    }
    fixes
}

/// What in a local folder needs uploading.
pub fn uploads(local: &[Local], server: &[Entry]) -> Vec<Upload> {
    let find = |name: &str, folder: bool| {
        server.iter().find(|e| e.is_folder == folder && key(&e.name) == key(name)).map(|e| e.id.clone())
    };
    local
        .iter()
        .filter(|item| !is_local_only(&item.name))
        .filter_map(|item| match &item.stamp {
            None if item.is_dir => Some(Upload::Folder { name: item.name.clone(), existing: find(&item.name, true) }),
            None => Some(Upload::File { name: item.name.clone(), replace: find(&item.name, false) }),
            Some(stamp) if !item.is_dir && !item.in_sync => {
                Some(Upload::Changed { name: item.name.clone(), id: stamp.id.clone(), base: stamp.version })
            }
            Some(_) => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn entry(id: &str, name: &str, folder: bool, ms: i64) -> Entry {
        Entry {
            id: id.into(),
            name: name.into(),
            is_folder: folder,
            size: 3,
            modified: Utc.timestamp_millis_opt(ms).single().unwrap(),
            accessed: None,
            version: ms,
            editor: None,
        }
    }

    fn placeholder(name: &str, id: &str, version: i64, in_sync: bool) -> Local {
        Local { name: name.into(), is_dir: false, stamp: Some(Stamp { id: id.into(), version }), in_sync }
    }

    fn plain(name: &str, is_dir: bool) -> Local {
        Local { name: name.into(), is_dir, stamp: None, in_sync: false }
    }

    #[test]
    fn a_file_renamed_while_open_is_found_and_saved_by_id() {
        // Excel holds "Invoice.xlsx" while the server renames it; the rename waits here.
        let server = [entry("a", "Invoice details.xlsx", false, 5)];
        let held = [placeholder("Invoice.xlsx", "a", 5, true)];
        assert_eq!(holding(&held, "a").map(|l| l.name.as_str()), Some("Invoice.xlsx"));
        // Its save replaces the placeholder with a new file under the old name; only the
        // scratch backup still carries the id until Excel deletes it.
        let saved = [plain("Invoice.xlsx", false), placeholder("9C2F1A00", "a", 5, false)];
        assert_eq!(holding(&saved, "a"), None);
        assert!(renamed_while_open(&saved, &server, "a"));
        // Not when the renamed file is here already, or gone from the server.
        let both = [plain("Invoice.xlsx", false), placeholder("Invoice details.xlsx", "a", 5, true)];
        assert!(!renamed_while_open(&both, &server, "a"));
        assert!(!renamed_while_open(&saved, &[entry("b", "Other.xlsx", false, 5)], "a"));
        assert!(!renamed_while_open(&saved, &[entry("a", "Invoice details", true, 5)], "a"));
        // The save went into "a" and its new name came down meanwhile; once Excel lets go,
        // the old-name copy is marked as "a" too, and goes unless it changed again.
        let done = [placeholder("Invoice.xlsx", "a", 6, true), placeholder("Invoice details.xlsx", "a", 6, true)];
        let server = [entry("a", "Invoice details.xlsx", false, 6)];
        assert_eq!(reconcile(&done, &server), [Fix::Remove("Invoice.xlsx".into())]);
        let edited = [placeholder("Invoice.xlsx", "a", 6, false), placeholder("Invoice details.xlsx", "a", 6, true)];
        assert_eq!(reconcile(&edited, &server), []);
    }

    #[test]
    fn stamps_round_trip() {
        let s = Stamp { id: "abc".into(), version: 42 };
        assert_eq!(Stamp::decode(&s.encode()), Some(s));
        assert_eq!(Stamp::decode(b"only-id"), Some(Stamp { id: "only-id".into(), version: 0 }));
        assert_eq!(Stamp::decode(b""), None);
        assert_eq!(Stamp::decode(Stamp::UNSTAMPED), None);
    }

    #[test]
    fn creates_missing_and_removes_gone() {
        let local = vec![placeholder("old.txt", "1", 5, true)];
        let server = vec![entry("2", "new.txt", false, 5)];
        let fixes = reconcile(&local, &server);
        assert_eq!(fixes, vec![Fix::Remove("old.txt".into()), Fix::Create(server[0].clone())]);
    }

    #[test]
    fn follows_server_renames_and_updates() {
        let local = vec![placeholder("a.txt", "1", 5, true), placeholder("b.txt", "2", 5, true)];
        let server = vec![entry("1", "renamed.txt", false, 5), entry("2", "b.txt", false, 9)];
        let fixes = reconcile(&local, &server);
        assert_eq!(
            fixes,
            vec![
                Fix::Rename { from: "a.txt".into(), entry: server[0].clone() },
                Fix::Update { name: "b.txt".into(), entry: server[1].clone() },
            ]
        );
    }

    #[test]
    fn never_touches_local_work() {
        // Edited here, deleted on the server: kept for upload.
        let local = vec![placeholder("draft.txt", "1", 5, false), plain("mine.txt", false)];
        // A server file with the same name as a local new one is not added beside it.
        let server = vec![entry("9", "mine.txt", false, 5)];
        assert!(reconcile(&local, &server).is_empty());
        // An edited placeholder is not refreshed even if the server changed.
        let local = vec![placeholder("a.txt", "1", 5, false)];
        assert!(reconcile(&local, &[entry("1", "a.txt", false, 9)]).is_empty());
    }

    #[test]
    fn replaced_on_server_swaps_the_placeholder() {
        let local = vec![placeholder("a.txt", "1", 5, true)];
        let server = vec![entry("2", "a.txt", false, 5)];
        let fixes = reconcile(&local, &server);
        assert_eq!(fixes, vec![Fix::Remove("a.txt".into()), Fix::Create(server[0].clone())]);
    }

    #[test]
    fn office_scratch_names_stay_local() {
        for name in ["~WRL0001.tmp", "~WRD0000.tmp", "ppt1A2B.tmp", "B9EC1600", "~$port.docx"] {
            assert!(is_local_only(name), "{name}");
        }
        for name in ["Contacts.csv", "b9ec1600", "B9EC160", "B9EC1600.csv", "DEADBEEF1"] {
            assert!(!is_local_only(name), "{name}");
        }
        assert!(is_save_backup("Roadmap 2027.docx", "~WRL0001.tmp"));
        assert!(is_save_backup("Contacts.csv", "B9EC1600"));
        assert!(!is_save_backup("~WRD0000.tmp", "Roadmap 2027.docx"));
        assert!(!is_save_backup("a.txt", "b.txt"));
    }

    #[test]
    fn a_save_backup_is_not_renamed_back() {
        // Word renamed the document to its backup name; the server still has the real name.
        let local = vec![placeholder("~WRL0001.tmp", "1", 5, true)];
        let server = vec![entry("1", "Roadmap 2027.docx", false, 5)];
        assert!(reconcile(&local, &server).is_empty());
    }

    #[test]
    fn plans_uploads() {
        let local = vec![
            plain("new.txt", false),
            plain("~$Report.docx", false),
            plain("Report.docx", false),
            plain("Folder", true),
            placeholder("edited.txt", "7", 5, false),
            placeholder("same.txt", "8", 5, true),
        ];
        let server = vec![entry("3", "report.docx", false, 5), entry("4", "folder", true, 5)];
        assert_eq!(
            uploads(&local, &server),
            vec![
                Upload::File { name: "new.txt".into(), replace: None },
                Upload::File { name: "Report.docx".into(), replace: Some("3".into()) },
                Upload::Folder { name: "Folder".into(), existing: Some("4".into()) },
                Upload::Changed { name: "edited.txt".into(), id: "7".into(), base: 5 },
            ]
        );
    }

    #[test]
    fn conflicted_copies_keep_the_extension() {
        assert_eq!(conflict_name("Report.xlsx", "2026-10-15 1946"), "Report (conflicted copy 2026-10-15 1946).xlsx");
        assert_eq!(conflict_name("Makefile", "d"), "Makefile (conflicted copy d)");
        assert_eq!(conflict_name(".env", "d"), ".env (conflicted copy d)");
        assert_eq!((base(0), base(3)), (None, Some(3)));
    }
}
