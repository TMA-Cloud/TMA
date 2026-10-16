//! The state every handler and background task shares.

use std::ops::Deref;
use std::sync::Arc;

use sqlx::PgPool;

use crate::cache::Cache;
use crate::config::Config;
use crate::crypto::Keyring;
use crate::jobs::JobQueue;
use crate::services::access::AccessTracker;
use crate::services::audit::AuditLog;
use crate::services::events::EventHub;
use crate::services::limits::RateLimits;
use crate::services::metrics::Metrics;
use crate::settings::SettingsCache;
use crate::storage::Storage;

pub struct Inner {
    pub config: Config,
    pub pool: PgPool,
    pub cache: Cache,
    pub settings: SettingsCache,
    pub storage: Storage,
    pub keyring: Arc<Keyring>,
    pub jobs: JobQueue,
    pub audit: AuditLog,
    pub events: EventHub,
    pub access: AccessTracker,
    pub limits: RateLimits,
    pub metrics: Metrics,
    pub http: reqwest::Client,
    /// Networks whose forwarded headers are trusted for the client address.
    pub trusted_proxies: Vec<ipnet::IpNet>,
    /// CSP hashes of the inline scripts in the web app's index.html.
    pub spa_script_hashes: crate::middleware::SpaHashes,
    pub google: crate::auth::google::GoogleConfigCache,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    /// Drop every process's settings snapshot after a write.
    pub async fn settings_changed(&self) {
        self.settings.invalidate().await;
        self.cache.publish(crate::settings::CHANGED_CHANNEL, "settings").await;
    }

    /// Drop every process's cached bucket client after the storage settings changed.
    pub async fn storage_changed(&self) {
        self.storage.invalidate().await;
        self.settings_changed().await;
        self.cache.publish(crate::settings::CHANGED_CHANNEL, "storage").await;
    }
}
