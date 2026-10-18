//! Files, folders, uploads, shares and live events.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    #[default]
    File,
    Folder,
}

impl ItemType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Folder => "folder",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("folder") { Self::Folder } else { Self::File }
    }
}

/// One row of a listing. Folders report their aggregate size.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FileItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    #[serde(default)]
    pub size: Option<i64>,
    pub modified: DateTime<Utc>,
    #[serde(rename = "accessedAt", default)]
    pub accessed_at: Option<DateTime<Utc>>,
    #[serde(rename = "sharedAt", default)]
    pub shared_at: Option<DateTime<Utc>>,
    #[serde(rename = "mimeType", default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub starred: bool,
    #[serde(default)]
    pub shared: bool,
    /// Share expiry: `null` while unshared or shared without expiry.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(rename = "deletedAt", default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<DateTime<Utc>>,
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Raised by every content replace; a save names the one it started from
    /// (`baseVersion`) so a stale copy is refused rather than overwriting.
    #[serde(rename = "contentVersion", default)]
    pub content_version: i64,
    /// Who opened the file last; only Recent files reports it.
    #[serde(rename = "openedBy", default, skip_serializing_if = "Option::is_none")]
    pub opened_by: Option<Opener>,
    /// Echo of the uploader's per-file id in a bulk upload response.
    #[serde(rename = "clientId", default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

/// A signed-in identity that opened a file: the account itself or one of its sub-users.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Opener {
    pub id: String,
    /// The display name, or the email when the user has no name.
    pub name: String,
}

impl FileItem {
    pub fn is_folder(&self) -> bool {
        self.item_type == ItemType::Folder
    }
}

/// Dashboard counts.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStats {
    pub total_files: i64,
    pub total_folders: i64,
    pub shared_count: i64,
    pub starred_count: i64,
}

/// Recursive totals shown for a folder in Get Info.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub total_size: i64,
    pub file_count: i64,
    pub folder_count: i64,
}

/// Get Info: the item, its location and, for folders, recursive totals.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub size: Option<i64>,
    pub modified: DateTime<Utc>,
    #[serde(default)]
    pub accessed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub starred: bool,
    #[serde(default)]
    pub shared: bool,
    #[serde(default)]
    pub shared_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub location_path: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_info: Option<FolderInfo>,
}

/// A file the uploader refused or the server failed to store.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadFailure {
    pub file_name: String,
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

/// Result of `POST /api/files/upload/bulk`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BulkUploadResponse {
    pub files: Vec<FileItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<Vec<UploadFailure>>,
    pub total: usize,
    pub successful: usize,
    pub failed_count: usize,
}

/// `{ links: { fileId: url } }` from share and link endpoints.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareLinks {
    #[serde(default)]
    pub links: std::collections::BTreeMap<String, String>,
}

/// Body of `POST /api/files/share`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareRequest {
    pub ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<bool>,
    /// "7d", "30d" or "never".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry: Option<String>,
}

/// Storage figures for the signed-in account; `total`/`free` are null when unlimited.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageUsage {
    pub used: i64,
    #[serde(default)]
    pub total: Option<i64>,
    #[serde(default)]
    pub free: Option<i64>,
}

/// One entry of a public shared-folder page (`Accept: application/json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size: Option<i64>,
}

/// A page of a public shared folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedPage {
    pub items: Vec<SharedItem>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// Envelope of a server-sent file event.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FileEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl FileEvent {
    /// Handshake and errors carry no change worth refreshing for.
    pub fn is_change(&self) -> bool {
        !matches!(self.event_type.as_str(), "connected" | "error")
    }
}

/// Sortable listing columns, as the API names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum SortBy {
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "size")]
    Size,
    #[default]
    #[serde(rename = "modified")]
    Modified,
    #[serde(rename = "accessedAt")]
    AccessedAt,
    #[serde(rename = "deletedAt")]
    DeletedAt,
}

impl SortBy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Name => "name",
            Self::Size => "size",
            Self::Modified => "modified",
            Self::AccessedAt => "accessedAt",
            Self::DeletedAt => "deletedAt",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "name" => Self::Name,
            "size" => Self::Size,
            "modified" => Self::Modified,
            "accessedAt" => Self::AccessedAt,
            "deletedAt" => Self::DeletedAt,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum SortOrder {
    #[serde(rename = "ASC")]
    Asc,
    #[default]
    #[serde(rename = "DESC")]
    Desc,
}

impl SortOrder {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_uppercase().as_str() {
            "ASC" => Some(Self::Asc),
            "DESC" => Some(Self::Desc),
            _ => None,
        }
    }
}

/// The OnlyOffice editor session for one document.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnlyOfficeSession {
    pub config: serde_json::Value,
    #[serde(default)]
    pub token: Option<String>,
    pub onlyoffice_js_url: String,
}
