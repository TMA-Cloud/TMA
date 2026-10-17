use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use chrono::Utc;

use super::*;
use crate::backend::{Backend, BackendResult, Entry, Space};

/// parent, name, is_folder, bytes
type Item = (Option<String>, String, bool, Vec<u8>);

#[derive(Default)]
struct Mock {
    items: Mutex<HashMap<String, Item>>,
    next: Mutex<u32>,
    uploads: Mutex<u32>,
    /// An item the next listing leaves out, as a listing taken just before it was made would.
    hide_once: Mutex<Option<String>>,
}

impl Mock {
    fn id(&self) -> String {
        let mut n = self.next.lock().unwrap();
        *n += 1;
        format!("id{n}")
    }

    fn find(&self, parent: Option<&str>, name: &str) -> Option<String> {
        self.items.lock().unwrap().iter().find(|(_, v)| v.0.as_deref() == parent && v.1 == name).map(|(k, _)| k.clone())
    }

    fn bytes(&self, id: &str) -> Vec<u8> {
        self.items.lock().unwrap().get(id).map(|v| v.3.clone()).unwrap_or_default()
    }
}

impl Backend for Mock {
    fn list(&self, parent: Option<&str>) -> BackendResult<Vec<Entry>> {
        let hidden = self.hide_once.lock().unwrap().take();
        Ok(self
            .items
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, v)| v.0.as_deref() == parent && hidden.as_deref() != Some(k.as_str()))
            .map(|(k, v)| Entry {
                id: k.clone(),
                name: v.1.clone(),
                is_folder: v.2,
                size: v.3.len() as u64,
                modified: Utc::now(),
                accessed: None,
            })
            .collect())
    }
    fn download(&self, id: &str, dest: &Path) -> BackendResult<()> {
        std::fs::write(dest, self.bytes(id)).map_err(|e| e.to_string())
    }
    fn download_with(&self, id: &str, sink: &mut (dyn FnMut(&[u8]) -> Result<(), String> + Send)) -> BackendResult<()> {
        sink(&self.bytes(id))
    }
    fn upload(&self, parent: Option<&str>, name: &str, src: &Path) -> BackendResult<String> {
        *self.uploads.lock().unwrap() += 1;
        let id = self.id();
        let data = std::fs::read(src).map_err(|e| e.to_string())?;
        self.items.lock().unwrap().insert(id.clone(), (parent.map(String::from), name.into(), false, data));
        Ok(id)
    }
    fn replace(&self, id: &str, _name: &str, src: &Path) -> BackendResult<()> {
        let data = std::fs::read(src).map_err(|e| e.to_string())?;
        self.items.lock().unwrap().get_mut(id).ok_or("missing")?.3 = data;
        Ok(())
    }
    fn mkdir(&self, parent: Option<&str>, name: &str) -> BackendResult<String> {
        // As the server: a live sibling's name, in any case, is refused.
        let taken = self
            .items
            .lock()
            .unwrap()
            .values()
            .any(|v| v.0.as_deref() == parent && v.1.to_lowercase() == name.to_lowercase());
        if taken {
            return Err("An item with this name is already here".into());
        }
        let id = self.id();
        self.items.lock().unwrap().insert(id.clone(), (parent.map(String::from), name.into(), true, Vec::new()));
        Ok(id)
    }
    fn rename(&self, id: &str, name: &str) -> BackendResult<()> {
        self.items.lock().unwrap().get_mut(id).ok_or("missing")?.1 = name.into();
        Ok(())
    }
    fn move_to(&self, id: &str, parent: Option<&str>) -> BackendResult<()> {
        self.items.lock().unwrap().get_mut(id).ok_or("missing")?.0 = parent.map(String::from);
        Ok(())
    }
    fn delete(&self, id: &str) -> BackendResult<()> {
        self.items.lock().unwrap().remove(id);
        Ok(())
    }
    fn space(&self) -> BackendResult<Space> {
        Ok(Space { used: 10, total: None })
    }
    fn save_only(&self) -> BackendResult<bool> {
        Ok(false)
    }
}

fn setup() -> (Arc<Mock>, Core, tempdir::Dir) {
    let mock = Arc::new(Mock::default());
    let dir = tempdir::Dir::new();
    let core = Core::new(mock.clone(), dir.0.clone(), true).unwrap();
    (mock, core, dir)
}

mod tempdir {
    pub struct Dir(pub std::path::PathBuf);
    impl Dir {
        pub fn new() -> Self {
            let p = std::env::temp_dir().join(format!("tma-drive-test-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn save(core: &Core, path: &str, data: &[u8]) {
    let h = core.create(path, false).unwrap();
    core.write(&h, 0, data, false, false).unwrap();
    core.cleanup(&h, false);
    core.close(&h);
}

#[test]
fn create_write_uploads_once() {
    let (mock, core, _d) = setup();
    save(&core, "\\a.txt", b"hello");
    let id = mock.find(None, "a.txt").unwrap();
    assert_eq!(mock.bytes(&id), b"hello");
    assert_eq!(*mock.uploads.lock().unwrap(), 1);
    // Reading back goes through a fresh download.
    let h = core.open("\\a.txt").unwrap();
    let mut buf = [0u8; 16];
    let n = core.read(&h, 0, &mut buf).unwrap();
    assert_eq!(&buf[..n], b"hello");
    assert_eq!(core.read(&h, 5, &mut buf), Err(FsError::EndOfFile));
}

#[test]
fn empty_create_stays_local_until_written() {
    let (mock, core, _d) = setup();
    let h = core.create("\\new.docx", false).unwrap();
    core.cleanup(&h, false);
    core.close(&h);
    assert!(mock.find(None, "new.docx").is_none());
    // The placeholder is listed, and writing to it uploads it.
    let node = core.resolve("\\new.docx").unwrap().unwrap();
    assert!(node.id.is_none());
    let h = core.open("\\new.docx").unwrap();
    core.write(&h, 0, b"doc", false, false).unwrap();
    core.cleanup(&h, false);
    assert_eq!(mock.bytes(&mock.find(None, "new.docx").unwrap()), b"doc");
}

#[test]
fn saving_again_replaces_instead_of_duplicating() {
    let (mock, core, _d) = setup();
    save(&core, "\\r.txt", b"one");
    core.invalidate_all();
    save(&core, "\\r.txt", b"two");
    assert_eq!(mock.list(None).unwrap().len(), 1);
    assert_eq!(mock.bytes(&mock.find(None, "r.txt").unwrap()), b"two");
}

#[test]
fn temp_then_rename_over_existing() {
    // Word and Excel save to a temporary name, then rename over the original.
    let (mock, core, _d) = setup();
    save(&core, "\\report.docx", b"v1");
    let id = mock.find(None, "report.docx").unwrap();
    save(&core, "\\~WRD0001.tmp", b"v2");
    core.rename("\\~WRD0001.tmp", "\\report.docx").unwrap();
    let entries = mock.list(None).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "report.docx");
    assert_eq!(entries[0].id, id, "the document keeps its id");
    assert_eq!(mock.bytes(&entries[0].id), b"v2");
}

fn delete(core: &Core, path: &str) {
    let h = core.open(path).unwrap();
    core.cleanup(&h, true);
    core.close(&h);
}

fn names(mock: &Mock) -> Vec<String> {
    let mut names: Vec<String> = mock.list(None).unwrap().into_iter().map(|e| e.name).collect();
    names.sort();
    names
}

/// The document renamed to a backup, the new copy written to `temp` and renamed
/// over it, then the backup deleted: how Word and Excel save.
fn office_save(core: &Core, doc: &str, backup: &str, temp: &str, data: &[u8]) {
    save(core, temp, data);
    core.rename(doc, backup).unwrap();
    assert!(core.resolve(doc).unwrap().is_none(), "the document is renamed away here");
    assert!(core.resolve(backup).unwrap().is_some());
    core.rename(temp, doc).unwrap();
    delete(core, backup);
}

#[test]
fn office_saves_keep_the_document_and_upload_no_scratch_files() {
    let (mock, core, _d) = setup();
    save(&core, "\\Roadmap.docx", b"v1");
    save(&core, "\\Contacts.csv", b"a");
    let (doc, csv) = (mock.find(None, "Roadmap.docx").unwrap(), mock.find(None, "Contacts.csv").unwrap());
    office_save(&core, "\\Roadmap.docx", "\\~WRL0001.tmp", "\\~WRD0000.tmp", b"v2");
    office_save(&core, "\\Contacts.csv", "\\B9EC1600", "\\A1B2C3D4", b"a,b");
    // A second save in a row behaves the same.
    office_save(&core, "\\Roadmap.docx", "\\~WRL0002.tmp", "\\~WRD0001.tmp", b"v3");
    assert_eq!(names(&mock), ["Contacts.csv", "Roadmap.docx"]);
    assert_eq!(mock.find(None, "Roadmap.docx").as_deref(), Some(doc.as_str()));
    assert_eq!(mock.find(None, "Contacts.csv").as_deref(), Some(csv.as_str()));
    assert_eq!(mock.bytes(&doc), b"v3");
    assert_eq!(mock.bytes(&csv), b"a,b");
    assert_eq!(*mock.uploads.lock().unwrap(), 2, "only the two documents were ever uploaded");
    assert!(core.resolve("\\~WRL0001.tmp").unwrap().is_none());
}

#[test]
fn libreoffice_saves_replace_in_place() {
    let (mock, core, _d) = setup();
    save(&core, "\\notes.odt", b"v1");
    let id = mock.find(None, "notes.odt").unwrap();
    save(&core, "\\lu12345.tmp", b"v2");
    assert!(mock.find(None, "lu12345.tmp").is_none(), "the temporary copy stays local");
    core.rename("\\lu12345.tmp", "\\notes.odt").unwrap();
    assert_eq!(names(&mock), ["notes.odt"]);
    assert_eq!(mock.bytes(&id), b"v2");
}

#[test]
fn backups_can_be_read_put_back_or_deleted_by_hand() {
    let (mock, core, _d) = setup();
    save(&core, "\\a.docx", b"old");
    let id = mock.find(None, "a.docx").unwrap();
    // A save that gives up puts the backup back: nothing changes on the server.
    core.rename("\\a.docx", "\\~WRL0001.tmp").unwrap();
    let h = core.open("\\~WRL0001.tmp").unwrap();
    let mut buf = [0u8; 8];
    assert_eq!(core.read(&h, 0, &mut buf), Ok(3));
    assert_eq!(&buf[..3], b"old");
    core.cleanup(&h, false);
    core.close(&h);
    core.rename("\\~WRL0001.tmp", "\\a.docx").unwrap();
    assert_eq!(names(&mock), ["a.docx"]);
    assert_eq!(core.resolve("\\a.docx").unwrap().and_then(|n| n.id), Some(id.clone()));
    // A file renamed to a scratch name by hand and then deleted is deleted.
    core.rename("\\a.docx", "\\a.tmp").unwrap();
    delete(&core, "\\a.tmp");
    assert!(mock.list(None).unwrap().is_empty());
}

#[test]
fn folders_are_reused_and_moves_work() {
    let (mock, core, _d) = setup();
    let a = core.create("\\Docs", true).unwrap();
    let b = core.create("\\Docs", true).unwrap();
    assert_eq!(a.node().id, b.node().id);
    save(&core, "\\x.txt", b"x");
    core.rename("\\x.txt", "\\Docs\\y.txt").unwrap();
    let docs = mock.find(None, "Docs").unwrap();
    assert!(mock.find(Some(&docs), "y.txt").is_some());
}

#[test]
fn save_only_refuses_reading_existing_files() {
    let (_mock, core, _d) = setup();
    save(&core, "\\s.txt", b"secret");
    core.deny_read.store(true, Ordering::Relaxed);
    let h = core.open("\\s.txt").unwrap();
    let mut buf = [0u8; 8];
    assert_eq!(core.read(&h, 0, &mut buf), Err(FsError::AccessDenied));
    // FUSE and NFS honour the same exception for what TMA Cloud opened.
    core.allow_read("\\s.txt", std::time::Duration::from_secs(60));
    let h = core.open("\\s.txt").unwrap();
    assert_eq!(core.read(&h, 0, &mut buf), Ok(6));
}

#[test]
fn delete_and_non_empty_folder() {
    let (mock, core, _d) = setup();
    core.create("\\F", true).unwrap();
    save(&core, "\\F\\in.txt", b"1");
    let f = core.open("\\F").unwrap();
    assert_eq!(core.can_delete(&f), Err(FsError::NotEmpty));
    let file = core.open("\\F\\in.txt").unwrap();
    core.cleanup(&file, true);
    assert!(mock.find(mock.find(None, "F").as_deref(), "in.txt").is_none());
}

#[test]
fn reserved_characters_round_trip() {
    let (mock, core, _d) = setup();
    mock.items.lock().unwrap().insert("q".into(), (None, "what?.txt".into(), false, b"q".to_vec()));
    let local = tma_core::names::server_to_windows("what?.txt");
    assert!(core.resolve(&format!("\\{local}")).unwrap().is_some());
}

#[test]
fn save_only_lets_through_what_tma_cloud_opened() {
    let (_mock, core, _dir) = setup();
    assert!(core.may_read(r"\Docs\a.txt"));
    core.deny_read.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(!core.may_read(r"\Docs\a.txt"));
    core.allow_read(r"\Docs", std::time::Duration::from_secs(60));
    assert!(core.may_read(r"\docs\A.txt"));
    assert!(core.may_read(r"\Docs"));
    assert!(!core.may_read(r"\Docs2\b.txt"));
    core.allow_read(r"\Old", std::time::Duration::ZERO);
    assert!(!core.may_read(r"\Old\c.txt"));
}

#[test]
fn drive_paths_use_windows_names() {
    let (_mock, core, _dir) = setup();
    let local = |name: &str| tma_core::names::server_to_windows(name);
    let expected = format!(r"\{}\{}", local("Q1: plans"), local("a?.txt"));
    assert_eq!(core.local_path(&["Q1: plans".into()], "a?.txt"), expected);
    assert_eq!(core.local_path(&[], "a.txt"), r"\a.txt");
}

fn folders_named(mock: &Mock, name: &str) -> usize {
    mock.items.lock().unwrap().values().filter(|v| v.2 && v.1.to_lowercase() == name.to_lowercase()).count()
}

#[test]
fn mkdir_reuses_a_folder_whatever_its_case() {
    let (mock, core, _d) = setup();
    mock.items.lock().unwrap().insert("old".into(), (None, "Äpfel".into(), true, Vec::new()));
    core.create("\\äpfel", true).unwrap();
    assert_eq!(folders_named(&mock, "äpfel"), 1);
}

#[test]
fn mkdir_after_a_stale_lookup_uses_the_existing_folder() {
    let (mock, core, _d) = setup();
    mock.items.lock().unwrap().insert("docs".into(), (None, "Docs".into(), true, Vec::new()));
    // The first lookup misses it; the server then refuses the name, and the second lookup finds it.
    *mock.hide_once.lock().unwrap() = Some("docs".into());
    core.create("\\Docs", true).unwrap();
    assert_eq!(folders_named(&mock, "docs"), 1);
}
