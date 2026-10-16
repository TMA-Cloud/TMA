//! What the drive needs from the server, as blocking calls (filesystem
//! callbacks run on the OS's own threads). The real backend is the API client;
//! tests use an in-memory one.

use std::path::Path;

use chrono::{DateTime, Utc};
use tma_client::{Client, ListQuery, Progress, Source, UploadFile, UploadOptions, View};

/// One entry of a folder listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: DateTime<Utc>,
    pub accessed: Option<DateTime<Utc>>,
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
    /// Upload a new file and return its id.
    fn upload(&self, parent: Option<&str>, name: &str, src: &Path) -> BackendResult<String>;
    /// Replace a file's contents; `name` is its current name (the type is read from it).
    fn replace(&self, id: &str, name: &str, src: &Path) -> BackendResult<()>;
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
}

/// The API client, driven from the shared async runtime.
pub struct ClientBackend {
    client: Client,
}

impl ClientBackend {
    pub fn new(client: Client) -> Self {
        Self { client }
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

    fn upload(&self, parent: Option<&str>, name: &str, src: &Path) -> BackendResult<String> {
        let file = upload_file(name, src)?;
        let options = UploadOptions { parent_id: parent.map(String::from) };
        tma_client::rt::block_on(self.client.upload(&file, &options, Progress::new(file.size)))
            .map(|f| f.id)
            .map_err(|e| e.message)
    }

    fn replace(&self, id: &str, name: &str, src: &Path) -> BackendResult<()> {
        let file = upload_file(name, src)?;
        tma_client::rt::block_on(self.client.replace(id, &file, Progress::new(file.size)))
            .map(|_| ())
            .map_err(|e| e.message)
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
}
