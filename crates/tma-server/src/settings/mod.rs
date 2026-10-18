//! `app_settings`: the instance settings the first user manages. Every process
//! keeps one snapshot of the row and re-reads it after a short TTL, or at once
//! when another process announces a change on Redis, so middleware that runs on
//! every request never waits on the database.

mod admin;
mod validate;

pub use admin::*;
pub use validate::*;

use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::PgPool;
use tma_core::api::ActivitySettings;
use tokio::sync::RwLock;

/// Redis channel that tells every process to drop its snapshot.
pub const CHANGED_CHANNEL: &str = "tma:settings:changed";
const TTL: Duration = Duration::from_secs(15);

pub const DEFAULT_MAX_UPLOAD_BYTES: i64 = 10 * 1024 * 1024 * 1024;
pub const MIN_MAX_UPLOAD_BYTES: i64 = 1024 * 1024;
pub const MAX_MAX_UPLOAD_BYTES: i64 = 100 * 1024 * 1024 * 1024;

/// The non-secret columns of `app_settings`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AppSettings {
    pub signup_enabled: Option<bool>,
    pub first_user_id: Option<String>,
    pub onlyoffice_jwt_secret: Option<String>,
    pub onlyoffice_url: Option<String>,
    pub share_base_url: Option<String>,
    pub max_upload_size_bytes: Option<i64>,
    pub hide_file_extensions: Option<bool>,
    pub desktop_only: Option<bool>,
    pub allow_password_change: Option<bool>,
    pub known_proxies: Vec<String>,
    pub session_idle_days: i32,
    pub access_time_tracking: bool,
    pub access_time_window_minutes: i32,
    pub access_time_flush_seconds: i32,
    pub cloud_drive_save_only: bool,
    pub storage_config_version: i32,
}

impl Default for AppSettings {
    fn default() -> Self {
        let a = ActivitySettings::DEFAULT;
        Self {
            signup_enabled: Some(true),
            first_user_id: None,
            onlyoffice_jwt_secret: None,
            onlyoffice_url: None,
            share_base_url: None,
            max_upload_size_bytes: Some(DEFAULT_MAX_UPLOAD_BYTES),
            hide_file_extensions: Some(false),
            desktop_only: Some(false),
            allow_password_change: Some(false),
            known_proxies: Vec::new(),
            session_idle_days: a.session_idle_days,
            access_time_tracking: a.access_time_tracking,
            access_time_window_minutes: a.access_time_window_minutes,
            access_time_flush_seconds: a.access_time_flush_seconds,
            cloud_drive_save_only: true,
            storage_config_version: 0,
        }
    }
}

impl AppSettings {
    pub fn max_upload_bytes(&self) -> i64 {
        self.max_upload_size_bytes
            .filter(|v| (MIN_MAX_UPLOAD_BYTES..=MAX_MAX_UPLOAD_BYTES).contains(v))
            .unwrap_or(DEFAULT_MAX_UPLOAD_BYTES)
    }

    pub fn activity(&self) -> ActivitySettings {
        let pick = |v: i32, (lo, hi): (i32, i32), d: i32| if (lo..=hi).contains(&v) { v } else { d };
        let d = ActivitySettings::DEFAULT;
        ActivitySettings {
            session_idle_days: pick(self.session_idle_days, ActivitySettings::IDLE_DAYS, d.session_idle_days),
            access_time_tracking: self.access_time_tracking,
            access_time_window_minutes: pick(
                self.access_time_window_minutes,
                ActivitySettings::WINDOW_MINUTES,
                d.access_time_window_minutes,
            ),
            access_time_flush_seconds: pick(
                self.access_time_flush_seconds,
                ActivitySettings::FLUSH_SECONDS,
                d.access_time_flush_seconds,
            ),
        }
    }

    /// The share domain's host (`share.example.com:8443`), when one is configured.
    pub fn share_base_host(&self) -> Option<String> {
        let url = url::Url::parse(self.share_base_url.as_deref()?.trim()).ok()?;
        let host = url.host_str()?;
        Some(match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        })
    }

    /// The share domain's origin, used to build public links.
    pub fn share_base_origin(&self) -> Option<String> {
        let url = url::Url::parse(self.share_base_url.as_deref()?.trim()).ok()?;
        Some(url.origin().ascii_serialization()).filter(|o| o != "null")
    }

    /// The OnlyOffice server, normalised, when both URL and secret are set.
    pub fn onlyoffice(&self) -> Option<(String, String)> {
        let url = normalize_onlyoffice_url(self.onlyoffice_url.as_deref()?).ok()?;
        let secret = self.onlyoffice_jwt_secret.clone().filter(|s| !s.is_empty())?;
        Some((url, secret))
    }

    /// Origin of the OnlyOffice server, allowed by the CSP.
    pub fn onlyoffice_origin(&self) -> Option<String> {
        let url = normalize_onlyoffice_url(self.onlyoffice_url.as_deref()?).ok()?;
        url::Url::parse(&url).ok().map(|u| u.origin().ascii_serialization())
    }
}

const SELECT_SETTINGS: &str =
    "SELECT signup_enabled, first_user_id, onlyoffice_jwt_secret, onlyoffice_url, share_base_url,
        max_upload_size_bytes, hide_file_extensions, desktop_only, allow_password_change,
        COALESCE(known_proxies, ARRAY[]::text[]) AS known_proxies, session_idle_days, access_time_tracking,
        access_time_window_minutes, access_time_flush_seconds, cloud_drive_save_only, storage_config_version
   FROM app_settings WHERE id = 'app_settings'";

/// A shared, self-refreshing snapshot of `app_settings`.
#[derive(Clone)]
pub struct SettingsCache {
    pool: PgPool,
    inner: Arc<RwLock<(Arc<AppSettings>, Option<Instant>)>>,
}

impl SettingsCache {
    pub fn new(pool: PgPool) -> Self {
        Self { pool, inner: Arc::new(RwLock::new((Arc::new(AppSettings::default()), None))) }
    }

    /// The current snapshot, re-read from the database once it is stale.
    pub async fn get(&self) -> Arc<AppSettings> {
        {
            let guard = self.inner.read().await;
            if guard.1.is_some_and(|at| at.elapsed() < TTL) {
                return guard.0.clone();
            }
        }
        match sqlx::query_as::<_, AppSettings>(SELECT_SETTINGS).fetch_optional(&self.pool).await {
            Ok(row) => {
                let snapshot = Arc::new(row.unwrap_or_default());
                *self.inner.write().await = (snapshot.clone(), Some(Instant::now()));
                snapshot
            }
            Err(err) => {
                tracing::warn!(error = %err, "Could not read app settings; keeping the last snapshot");
                self.inner.read().await.0.clone()
            }
        }
    }

    /// Drop the snapshot so the next read sees a change made in this process.
    pub async fn invalidate(&self) {
        self.inner.write().await.1 = None;
    }
}

/// Whether `user_id` is the first user (the instance administrator).
pub async fn is_first_user(pool: &PgPool, settings: &SettingsCache, user_id: &str) -> anyhow::Result<bool> {
    if let Some(first) = settings.get().await.first_user_id.as_deref() {
        return Ok(first == user_id);
    }
    // Not recorded yet: the oldest account is the first user, recorded once.
    let first: Option<String> =
        sqlx::query_scalar("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").fetch_optional(pool).await?;
    let is_first = first.as_deref() == Some(user_id);
    if is_first {
        let _ = sqlx::query(
            "UPDATE app_settings SET first_user_id = $1 WHERE id = 'app_settings' AND first_user_id IS NULL",
        )
        .bind(user_id)
        .execute(pool)
        .await;
        settings.invalidate().await;
    }
    Ok(is_first)
}
