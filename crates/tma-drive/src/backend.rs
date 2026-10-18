//! What the drive needs from the server, as blocking calls (filesystem
//! callbacks run on the OS's own threads). The real backend is the API client;
//! tests use an in-memory one.

use std::path::Path;

use chrono::{DateTime, Utc};
use tma_client::{Client, ListQuery, Progress, Source, UploadFile, UploadOptions, View};
use tma_core::api::FileLock;

/// One entry of a folder listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: DateTime<Utc>,
    pub accessed: Option<DateTime<Utc>>,
    /// The server's content version, raised by every save (0 from a server without it).
    pub version: i64,
    /// Who else has it open for editing (never the signed-in user).
    pub editor: Option<String>,
}

/// How the drive names the signed-in user editing on another computer.
pub const OTHER_COMPUTER: &str = "you, on another computer";
/// How the drive names the signed-in user editing in the browser.
pub const IN_BROWSER: &str = "you, in the browser";

/// The error a replace returns when someone else saved after `base`: the server
/// kept its copy, so the caller keeps the local one as a conflicted copy.
pub const CONFLICT: &str = "conflict: the file was saved by someone else";

/// What asking for a file's edit lock came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lock {
    Held,
    /// Someone else is editing it: their name.
    Busy(String),
}

/// Space figures; `total` is `None` for an unlimited account.
#[derive(Debug, Clone, Copy, Default)]
pub struct Space {
    pub used: u64,
    pub total: Option<u64>,
}

pub type BackendResult<T> = Result<T, String>;

pub trait Backend: Send + Sync {
    fn list(&self, parent: Option<&str>) -> BackendResult<Vec<Entry>>;
    fn download(&self, id: &str, dest: &Path) -> BackendResult<()>;
    /// Hand a file's bytes to `sink` as they arrive (Cloud Files writes them into the placeholder).
    fn download_with(&self, id: &str, sink: &mut (dyn FnMut(&[u8]) -> Result<(), String> + Send)) -> BackendResult<()>;
    /// Upload a new file and return its id.
    fn upload(&self, parent: Option<&str>, name: &str, src: &Path) -> BackendResult<String>;
    /// Replace a file's contents; `name` is its current name (the type is read from it).
    /// With `base`, only while the server is still at that content version, else `CONFLICT`.
    /// Returns the new content version.
    fn replace(&self, id: &str, name: &str, src: &Path, base: Option<i64>) -> BackendResult<i64>;
    fn mkdir(&self, parent: Option<&str>, name: &str) -> BackendResult<String>;
    fn rename(&self, id: &str, name: &str) -> BackendResult<()>;
    fn move_to(&self, id: &str, parent: Option<&str>) -> BackendResult<()>;
    /// Move to the trash, as deleting in the app does.
    fn delete(&self, id: &str) -> BackendResult<()>;
    fn space(&self) -> BackendResult<Space>;
    /// Whether the instance only allows saving into the drive.
    fn save_only(&self) -> BackendResult<bool>;
    /// Who is signed in, so a drive folder is never reused for another account.
    fn account(&self) -> BackendResult<String> {
        Ok(String::new())
    }
    /// Take or renew the edit lock on a file while an app here edits it.
    fn lock(&self, _id: &str) -> BackendResult<Lock> {
        Ok(Lock::Held)
    }
    fn unlock(&self, _id: &str) -> BackendResult<()> {
        Ok(())
    }
}

/// The API client, driven from the shared async runtime.
pub struct ClientBackend {
    client: Client,
    /// The signed-in user, so their own locks never read as someone else's.
    me: std::sync::OnceLock<String>,
}

impl ClientBackend {
    pub fn new(client: Client) -> Self {
        Self { client, me: std::sync::OnceLock::new() }
    }

    fn me(&self) -> Option<&str> {
        if self.me.get().is_none()
            && let Ok(id) = self.account()
        {
            let _ = self.me.set(id);
        }
        self.me.get().map(String::as_str)
    }
}

/// Who else is editing, as the drive names them; `None` for no one or this install itself.
fn editor(lock: &FileLock, me: Option<&str>) -> Option<String> {
    // Unknown who is signed in: show no one, rather than our own lock as someone else's.
    let me = me?;
    if lock.user_id != me {
        Some(lock.name.clone())
    } else if lock.in_browser() {
        Some(IN_BROWSER.into())
    } else if lock.device_id.as_deref() != tma_client::device_id() {
        Some(OTHER_COMPUTER.into())
    } else {
        None
    }
}

fn upload_file(name: &str, src: &Path) -> BackendResult<UploadFile> {
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    let modified_ms =
        meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    Ok(UploadFile {
        name: name.to_string(),
        size: meta.len(),
        source: Source::Path(src.to_path_buf()),
        modified_ms,
        relative_dir: None,
    })
}

impl Backend for ClientBackend {
    fn list(&self, parent: Option<&str>) -> BackendResult<Vec<Entry>> {
        let view = View::Folder(parent.map(String::from));
        let mut entries = Vec::new();
        let me = self.me();
        let mut query = ListQuery { limit: Some(500), ..Default::default() };
        // A folder can hold more than one page; the drive needs all of it.
        for _ in 0..200 {
            let page = tma_client::rt::block_on(self.client.list(&view, &query)).map_err(|e| e.message)?;
            entries.extend(page.files.into_iter().map(|f| Entry {
                is_folder: f.is_folder(),
                size: f.size.unwrap_or(0).max(0) as u64,
                id: f.id,
                name: f.name,
                modified: f.modified,
                accessed: f.accessed_at,
                version: f.content_version,
                editor: f.lock.and_then(|l| editor(&l, me)),
            }));
            match page.next_cursor {
                Some(cursor) => query.cursor = Some(cursor),
                None => break,
            }
        }
        Ok(entries)
    }

    fn download(&self, id: &str, dest: &Path) -> BackendResult<()> {
        tma_client::rt::block_on(self.client.download_to(id, dest, Progress::new(0))).map_err(|e| e.message)
    }

    fn download_with(&self, id: &str, sink: &mut (dyn FnMut(&[u8]) -> Result<(), String> + Send)) -> BackendResult<()> {
        tma_client::rt::block_on(self.client.download_with(id, sink)).map_err(|e| e.message)
    }

    fn upload(&self, parent: Option<&str>, name: &str, src: &Path) -> BackendResult<String> {
        let file = upload_file(name, src)?;
        let options = UploadOptions { parent_id: parent.map(String::from) };
        tma_client::rt::block_on(self.client.upload(&file, &options, Progress::new(file.size)))
            .map(|f| f.id)
            .map_err(|e| e.message)
    }

    fn replace(&self, id: &str, name: &str, src: &Path, base: Option<i64>) -> BackendResult<i64> {
        let file = upload_file(name, src)?;
        tma_client::rt::block_on(self.client.replace_from(id, &file, base, Progress::new(file.size)))
            .map(|f| f.content_version)
            .map_err(|e| if e.is_conflict() { CONFLICT.to_string() } else { e.message })
    }

    fn mkdir(&self, parent: Option<&str>, name: &str) -> BackendResult<String> {
        tma_client::rt::block_on(self.client.create_folder(name, parent)).map(|f| f.id).map_err(|e| e.message)
    }

    fn rename(&self, id: &str, name: &str) -> BackendResult<()> {
        tma_client::rt::block_on(self.client.rename(id, name)).map(|_| ()).map_err(|e| e.message)
    }

    fn move_to(&self, id: &str, parent: Option<&str>) -> BackendResult<()> {
        tma_client::rt::block_on(self.client.move_items(&[id.to_string()], parent)).map(|_| ()).map_err(|e| e.message)
    }

    fn delete(&self, id: &str) -> BackendResult<()> {
        tma_client::rt::block_on(self.client.trash(&[id.to_string()])).map(|_| ()).map_err(|e| e.message)
    }

    fn space(&self) -> BackendResult<Space> {
        let usage = tma_client::rt::block_on(self.client.storage_usage()).map_err(|e| e.message)?;
        Ok(Space { used: usage.used.max(0) as u64, total: usage.total.filter(|t| *t > 0).map(|t| t as u64) })
    }

    fn save_only(&self) -> BackendResult<bool> {
        tma_client::rt::block_on(self.client.cloud_drive_config()).map(|c| c.save_only).map_err(|e| e.message)
    }

    fn account(&self) -> BackendResult<String> {
        tma_client::rt::block_on(self.client.profile()).map(|u| u.id).map_err(|e| e.message)
    }

    fn lock(&self, id: &str) -> BackendResult<Lock> {
        let taken = tma_client::rt::block_on(self.client.lock(id)).map_err(|e| e.message)?;
        Ok(if taken.acquired {
            Lock::Held
        } else {
            Lock::Busy(editor(&taken.lock, self.me()).unwrap_or(taken.lock.name))
        })
    }

    fn unlock(&self, id: &str) -> BackendResult<()> {
        tma_client::rt::block_on(self.client.unlock(id)).map(|_| ()).map_err(|e| e.message)
    }
}
