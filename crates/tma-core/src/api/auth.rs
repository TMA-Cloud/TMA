//! Sign-in, sessions, MFA and the signed-in profile.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The signed-in identity, as `/api/profile` and login return it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_version: Option<i32>,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub mfa_enabled: bool,
    #[serde(rename = "isSubUser", default)]
    pub is_sub_user: bool,
    /// Owners hold every permission; sub-users exactly what was granted.
    #[serde(default)]
    pub permissions: Vec<String>,
}

impl User {
    pub fn display_name(&self) -> &str {
        match self.name.as_deref() {
            Some(n) if !n.trim().is_empty() => n,
            _ => &self.email,
        }
    }

    pub fn can(&self, permission: crate::Permission) -> bool {
        !self.is_sub_user || self.permissions.iter().any(|p| p == permission.key())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mfa_code: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `{ user }`, returned by login and signup.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserEnvelope {
    pub user: User,
}

/// One signed-in device on the Sessions screen.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionInfo {
    pub id: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub token_version: i32,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub ip_address: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    #[serde(default)]
    pub is_online: bool,
    #[serde(rename = "isCurrent", default)]
    pub is_current: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionList {
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevokeOthersResponse {
    pub message: String,
    pub deleted_count: i64,
}

/// MFA enrolment: the base32 secret and a PNG data URL of its QR code.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MfaSetup {
    pub secret: String,
    pub qr_code: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MfaEnabled {
    pub message: String,
    #[serde(default)]
    pub backup_codes: Vec<String>,
    #[serde(default)]
    pub should_prompt_sessions: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MfaStatus {
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupCodes {
    pub backup_codes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CountResponse {
    pub count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mfa_code: Option<String>,
}

/// `{ signupEnabled }` from the public signup status.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicSignupStatus {
    pub signup_enabled: bool,
}
