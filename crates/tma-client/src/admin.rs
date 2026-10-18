//! Instance settings, user administration, sub-users, orphans and versions.

use serde_json::{Value, json};
use tma_core::api::{
    ActiveClients, ActivitySettings, AdminUserPage, CloudDriveConfig, CreateSubUserRequest, KnownProxies,
    MaxUploadSize, MessageResponse, OnlyOfficeSettings, OrphanDeleteReport, OrphanReport, SignupStatus,
    StorageSettingsInput, StorageSettingsSummary, StorageStatus, StorageTestResult, StorageUsage, SubUserEnvelope,
    SubUserList, UpdateSubUserRequest, UrlSetting, Versions,
};

use crate::error::{ApiError, ApiResult};
use crate::http::{Client, enc};

/// A queued orphan job: still running, or finished with its report.
enum Polled<T> {
    Pending(String),
    Done(T),
}

fn polled<T: serde::de::DeserializeOwned>(value: Value) -> ApiResult<Polled<T>> {
    if let Some(job) = value.get("jobId").and_then(Value::as_str).filter(|_| value.get("status").is_some()) {
        return Ok(Polled::Pending(job.to_string()));
    }
    serde_json::from_value(value)
        .map(Polled::Done)
        .map_err(|e| ApiError::local(format!("Unexpected server response: {e}")))
}

impl Client {
    pub async fn signup_status(&self) -> ApiResult<SignupStatus> {
        self.get("/api/user/signup-status").await
    }

    pub async fn set_signup(&self, enabled: bool) -> ApiResult<Value> {
        self.post("/api/user/signup-toggle", &json!({ "enabled": enabled })).await
    }

    pub async fn set_hide_extensions(&self, hidden: bool) -> ApiResult<Value> {
        self.put("/api/user/hide-file-extensions-config", &json!({ "hidden": hidden })).await
    }

    pub async fn hide_extensions(&self) -> ApiResult<bool> {
        let v: Value = self.get("/api/user/hide-file-extensions-config").await?;
        Ok(v.get("hideFileExtensions").and_then(Value::as_bool).unwrap_or(false))
    }

    pub async fn set_desktop_only(&self, enabled: bool) -> ApiResult<Value> {
        self.put("/api/user/desktop-only-config", &json!({ "enabled": enabled })).await
    }

    pub async fn set_password_change(&self, enabled: bool) -> ApiResult<Value> {
        self.put("/api/user/password-change-config", &json!({ "enabled": enabled })).await
    }

    pub async fn cloud_drive_config(&self) -> ApiResult<CloudDriveConfig> {
        self.get("/api/user/cloud-drive-config").await
    }

    pub async fn set_cloud_drive_save_only(&self, save_only: bool) -> ApiResult<CloudDriveConfig> {
        self.put("/api/user/cloud-drive-config", &json!({ "saveOnly": save_only })).await
    }

    pub async fn onlyoffice_configured(&self) -> ApiResult<bool> {
        let v: Value = self.get("/api/user/onlyoffice-configured").await?;
        Ok(v.get("configured").and_then(Value::as_bool).unwrap_or(false))
    }

    pub async fn onlyoffice_config(&self) -> ApiResult<OnlyOfficeSettings> {
        self.get("/api/user/onlyoffice-config").await
    }

    /// An empty URL turns the integration off; a blank secret keeps the saved one.
    pub async fn save_onlyoffice_config(&self, url: &str, jwt_secret: Option<&str>) -> ApiResult<OnlyOfficeSettings> {
        self.put("/api/user/onlyoffice-config", &json!({ "url": url, "jwtSecret": jwt_secret })).await
    }

    pub async fn share_base_url(&self) -> ApiResult<UrlSetting> {
        self.get("/api/user/share-base-url-config").await
    }

    pub async fn save_share_base_url(&self, url: &str) -> ApiResult<UrlSetting> {
        self.put("/api/user/share-base-url-config", &json!({ "url": url })).await
    }

    pub async fn max_upload(&self) -> ApiResult<MaxUploadSize> {
        self.get("/api/user/max-upload-size-config").await
    }

    pub async fn save_max_upload(&self, max_bytes: i64) -> ApiResult<MaxUploadSize> {
        self.put("/api/user/max-upload-size-config", &json!({ "maxBytes": max_bytes })).await
    }

    pub async fn known_proxies(&self) -> ApiResult<KnownProxies> {
        self.get("/api/user/known-proxies-config").await
    }

    pub async fn save_known_proxies(&self, proxies: &[String]) -> ApiResult<KnownProxies> {
        self.put("/api/user/known-proxies-config", &json!({ "knownProxies": proxies })).await
    }

    pub async fn activity_settings(&self) -> ApiResult<ActivitySettings> {
        self.get("/api/user/activity-config").await
    }

    pub async fn save_session_timeout(&self, idle_days: i32) -> ApiResult<ActivitySettings> {
        self.put("/api/user/session-timeout-config", &json!({ "idleDays": idle_days })).await
    }

    pub async fn save_access_time(
        &self,
        enabled: bool,
        window_minutes: i32,
        flush_seconds: i32,
    ) -> ApiResult<ActivitySettings> {
        self.put(
            "/api/user/access-time-config",
            &json!({ "enabled": enabled, "windowMinutes": window_minutes, "flushSeconds": flush_seconds }),
        )
        .await
    }

    pub async fn storage_usage(&self) -> ApiResult<StorageUsage> {
        self.get("/api/user/storage").await
    }

    pub async fn storage_status(&self) -> ApiResult<StorageStatus> {
        self.get("/api/user/storage-status").await
    }

    pub async fn storage_config(&self) -> ApiResult<StorageSettingsSummary> {
        self.get("/api/user/storage-config").await
    }

    pub async fn test_storage_config(&self, input: &StorageSettingsInput) -> ApiResult<StorageTestResult> {
        self.post("/api/user/storage-config/test", input).await
    }

    pub async fn save_storage_config(&self, input: &StorageSettingsInput) -> ApiResult<StorageSettingsSummary> {
        self.put("/api/user/storage-config", input).await
    }

    pub async fn users(&self, cursor: Option<&str>) -> ApiResult<AdminUserPage> {
        match cursor {
            Some(c) => self.get(&format!("/api/user/all?limit=100&cursor={}", enc(c))).await,
            None => self.get("/api/user/all?limit=100").await,
        }
    }

    pub async fn set_storage_limit(&self, user_id: &str, limit: Option<i64>) -> ApiResult<Value> {
        self.put("/api/user/storage-limit", &json!({ "targetUserId": user_id, "storageLimit": limit })).await
    }

    pub async fn active_clients(&self) -> ApiResult<ActiveClients> {
        self.get("/api/user/active-clients").await
    }

    /// Presence for the desktop app, one row per install.
    pub async fn client_heartbeat(&self, app_version: &str, platform: &str, client_id: &str) -> ApiResult<()> {
        self.post::<_, Value>(
            "/api/user/client-heartbeat",
            &json!({ "appVersion": app_version, "platform": platform, "clientId": client_id }),
        )
        .await
        .map(|_| ())
    }

    pub async fn sub_users(&self) -> ApiResult<SubUserList> {
        self.get("/api/user/sub-users").await
    }

    pub async fn create_sub_user(&self, body: &CreateSubUserRequest) -> ApiResult<SubUserEnvelope> {
        self.post("/api/user/sub-users", body).await
    }

    pub async fn update_sub_user(&self, id: &str, permissions: &[String]) -> ApiResult<SubUserEnvelope> {
        self.put(
            &format!("/api/user/sub-users/{}", enc(id)),
            &UpdateSubUserRequest { permissions: permissions.to_vec() },
        )
        .await
    }

    pub async fn delete_sub_user(&self, id: &str) -> ApiResult<MessageResponse> {
        self.delete(&format!("/api/user/sub-users/{}", enc(id))).await
    }

    /// Queue an orphan scan and wait for its report.
    pub async fn scan_orphans(&self, grace_minutes: Option<i64>) -> ApiResult<OrphanReport> {
        let start = match grace_minutes {
            Some(g) => format!("/api/user/orphans?graceMinutes={g}"),
            None => "/api/user/orphans".to_string(),
        };
        let mut next = polled(self.get::<Value>(&start).await?)?;
        loop {
            match next {
                Polled::Done(report) => return Ok(report),
                Polled::Pending(job) => {
                    crate::rt::sleep(std::time::Duration::from_millis(800)).await;
                    next = polled(self.get::<Value>(&format!("/api/user/orphans?jobId={}", enc(&job))).await?)?;
                }
            }
        }
    }

    pub async fn delete_orphans(
        &self,
        storage_keys: &[String],
        file_ids: &[String],
        grace_minutes: i64,
    ) -> ApiResult<OrphanDeleteReport> {
        let body = json!({ "storageKeys": storage_keys, "fileIds": file_ids, "graceMinutes": grace_minutes });
        let mut next = polled(self.post::<_, Value>("/api/user/orphans/delete", &body).await?)?;
        loop {
            match next {
                Polled::Done(report) => return Ok(report),
                Polled::Pending(job) => {
                    crate::rt::sleep(std::time::Duration::from_millis(800)).await;
                    next = polled(self.post::<_, Value>("/api/user/orphans/delete", &json!({ "jobId": job })).await?)?;
                }
            }
        }
    }

    pub async fn versions(&self) -> ApiResult<Versions> {
        self.get("/api/version").await
    }

    pub async fn latest_versions(&self) -> ApiResult<Versions> {
        self.get("/api/version/latest").await
    }
}
