//! Instance settings the first user manages, user administration and sub-users.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::permissions::PermissionInfo;

/// `/api/user/signup-status` for a signed-in user.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignupStatus {
    pub signup_enabled: bool,
    #[serde(default)]
    pub can_toggle: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_users: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_users: Option<i64>,
    #[serde(default)]
    pub hide_file_extensions: bool,
    #[serde(default)]
    pub can_toggle_hide_file_extensions: bool,
    #[serde(default)]
    pub desktop_only: bool,
    #[serde(default)]
    pub can_toggle_desktop_only: bool,
    #[serde(default)]
    pub allow_password_change: bool,
    #[serde(default)]
    pub can_toggle_allow_password_change: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlyOfficeSettings {
    pub jwt_secret_set: bool,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UrlSetting {
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaxUploadSize {
    pub max_bytes: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HideExtensions {
    pub hide_file_extensions: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOnly {
    pub desktop_only: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChangeSetting {
    pub allow_password_change: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudDriveConfig {
    pub save_only: bool,
    #[serde(default)]
    pub can_configure: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySettings {
    pub session_idle_days: i32,
    pub access_time_tracking: bool,
    pub access_time_window_minutes: i32,
    pub access_time_flush_seconds: i32,
}

impl ActivitySettings {
    /// Inclusive ranges, the same the database enforces (migration 051).
    pub const IDLE_DAYS: (i32, i32) = (1, 365);
    pub const WINDOW_MINUTES: (i32, i32) = (0, 1440);
    pub const FLUSH_SECONDS: (i32, i32) = (1, 300);

    /// The values a new instance starts with.
    pub const DEFAULT: Self = Self {
        session_idle_days: 30,
        access_time_tracking: true,
        access_time_window_minutes: 60,
        access_time_flush_seconds: 10,
    };
}

impl Default for ActivitySettings {
    fn default() -> Self {
        Self::DEFAULT
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownProxies {
    pub known_proxies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_required: Option<bool>,
}

/// One user row in the admin list; sub-users follow their owner.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminUser {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub mfa_enabled: bool,
    #[serde(default)]
    pub storage_limit: Option<i64>,
    #[serde(default)]
    pub storage_used: i64,
    #[serde(default)]
    pub storage_total: Option<i64>,
    #[serde(default)]
    pub parent_user_id: Option<String>,
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserPage {
    pub users: Vec<AdminUser>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageLimitRequest {
    pub target_user_id: String,
    pub storage_limit: Option<i64>,
}

/// What the admin UI may see of the bucket settings: never the secret.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageSettingsSummary {
    pub configured: bool,
    pub version: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_path_style: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_key_id_masked: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

/// Body of `PUT /api/user/storage-config` (and its test). Blank credentials keep the saved pair.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageSettingsInput {
    pub provider: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub bucket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_path_style: Option<bool>,
    #[serde(default)]
    pub access_key_id: Option<String>,
    #[serde(default)]
    pub secret_access_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<i32>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub configured: bool,
    #[serde(default)]
    pub can_configure: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageTestResult {
    pub ok: bool,
    #[serde(default)]
    pub checks: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuthSummary {
    pub configured: bool,
    pub version: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuthInput {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<i32>,
}

/// A desktop app seen in the last few minutes.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveClient {
    pub id: String,
    pub user_id: String,
    #[serde(default)]
    pub user_name: Option<String>,
    #[serde(default)]
    pub user_email: Option<String>,
    pub app_version: String,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub ip_address: Option<String>,
    pub last_seen_at: DateTime<Utc>,
    pub connected_since: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveClients {
    pub clients: Vec<ActiveClient>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientHeartbeat {
    pub app_version: String,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubUser {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub mfa_enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubUserList {
    pub sub_users: Vec<SubUser>,
    #[serde(default)]
    pub available_permissions: Vec<PermissionInfo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubUserEnvelope {
    pub sub_user: SubUser,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateSubUserRequest {
    pub email: String,
    pub password: String,
    pub name: String,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateSubUserRequest {
    pub permissions: Vec<String>,
}

/// An object in the bucket no file row points at.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageOrphan {
    pub key: String,
    pub size: i64,
    #[serde(default)]
    pub last_modified: Option<DateTime<Utc>>,
}

/// A file row whose object is missing from the bucket.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOrphan {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: i64,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub modified: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub trashed: bool,
    #[serde(default)]
    pub owner_email: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanCategory<T> {
    pub items: Vec<T>,
    pub count: i64,
    pub total_bytes: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanTotals {
    pub stored_objects: i64,
    pub database_rows: i64,
    pub skipped_too_recent: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanReport {
    pub scanned_at: DateTime<Utc>,
    pub grace_minutes: i64,
    pub driver: String,
    pub totals: OrphanTotals,
    pub storage_orphans: OrphanCategory<StorageOrphan>,
    pub database_orphans: OrphanCategory<DatabaseOrphan>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanItemResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrphanDeleteOutcome {
    pub results: Vec<OrphanItemResult>,
    pub deleted: i64,
    pub skipped: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDeleteReport {
    pub grace_minutes: i64,
    pub storage: OrphanDeleteOutcome,
    pub database: OrphanDeleteOutcome,
}
