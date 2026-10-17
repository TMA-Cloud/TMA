//! Redis: a small JSON cache for hot, cheaply invalidated lookups (token
//! versions, account context, session activity, settings) and the pub/sub
//! channel that carries file events between processes. Every call degrades to
//! a miss when Redis is down; nothing here is a source of truth.

use std::sync::Arc;
use std::time::Duration;

use redis::AsyncCommands;
use redis::aio::ConnectionManager;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::RwLock;

/// Default lifetime of a cache entry.
pub const DEFAULT_TTL: u64 = 300;
/// Not JSON, so reads of an invalidated key miss.
const INVALIDATED: &str = "!invalidated";
/// Longer than any database read a fill waits on.
const INVALIDATED_TTL: u64 = 60;

#[derive(Clone)]
pub struct Cache {
    client: redis::Client,
    conn: Arc<RwLock<Option<ConnectionManager>>>,
}

impl Cache {
    /// Connect, or keep retrying in the background so the server starts without Redis.
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(url)?;
        let cache = Self { client, conn: Arc::new(RwLock::new(None)) };
        if !cache.try_connect().await {
            tracing::error!("Failed to connect to Redis — running in degraded mode (no caching)");
            let retry = cache.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    if retry.try_connect().await {
                        tracing::info!("Redis connected");
                        break;
                    }
                }
            });
        }
        Ok(cache)
    }

    async fn try_connect(&self) -> bool {
        match tokio::time::timeout(Duration::from_secs(5), ConnectionManager::new(self.client.clone())).await {
            Ok(Ok(manager)) => {
                *self.conn.write().await = Some(manager);
                true
            }
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "Redis connection failed");
                false
            }
            Err(_) => {
                tracing::warn!("Redis connection timed out");
                false
            }
        }
    }

    pub fn client(&self) -> &redis::Client {
        &self.client
    }

    async fn conn(&self) -> Option<ConnectionManager> {
        self.conn.read().await.clone()
    }

    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let mut conn = self.conn().await?;
        let raw: Option<String> =
            conn.get(key).await.map_err(|e| tracing::warn!(error = %e, "Error getting from cache")).ok()?;
        raw.and_then(|s| serde_json::from_str(&s).ok())
    }

    /// Store what a lookup read from the database, unless the key holds a value
    /// or an invalidation marker: a fill that read before a change must not undo it.
    pub async fn fill<T: Serialize + ?Sized>(&self, key: &str, value: &T, ttl: u64) {
        let Some(mut conn) = self.conn().await else { return };
        let Ok(text) = serde_json::to_string(value) else { return };
        let options = redis::SetOptions::default()
            .conditional_set(redis::ExistenceCheck::NX)
            .with_expiration(redis::SetExpiry::EX(ttl));
        if let Err(err) = conn.set_options::<_, _, ()>(key, text, options).await {
            tracing::warn!(error = %err, "Error setting cache");
        }
    }

    /// Drop cached values after a database change. Each key holds a marker for a
    /// while, which reads treat as a miss and which blocks fills already in flight.
    pub async fn invalidate(&self, keys: &[String]) {
        if keys.is_empty() {
            return;
        }
        let Some(mut conn) = self.conn().await else { return };
        let mut pipe = redis::pipe();
        for key in keys {
            pipe.set_ex(key, INVALIDATED, INVALIDATED_TTL).ignore();
        }
        if let Err(err) = pipe.query_async::<()>(&mut conn).await {
            // Keys carry session ids and share tokens, so they stay out of the log.
            tracing::error!(error = %err, count = keys.len(), "Failed to invalidate cache");
        }
    }

    /// Publish a message on a channel; false when Redis did not take it.
    pub async fn publish(&self, channel: &str, message: &str) -> bool {
        let Some(mut conn) = self.conn().await else { return false };
        match conn.publish::<_, _, ()>(channel, message).await {
            Ok(()) => true,
            Err(err) => {
                tracing::error!(error = %err, channel, "Failed to publish");
                false
            }
        }
    }
}

/// Cache keys, in one place so writers and invalidators agree.
pub mod keys {
    pub fn user_by_id(id: &str) -> String {
        format!("user:{id}:id")
    }
    pub fn token_version(id: &str) -> String {
        format!("user:{id}:token_version")
    }
    pub fn account(id: &str) -> String {
        format!("user:{id}:account")
    }
    pub fn session(session_id: &str, user_id: &str, token_version: i32) -> String {
        format!("session:{user_id}:{session_id}:{token_version}")
    }
    pub fn share_by_token(token: &str) -> String {
        format!("share:token:{token}")
    }
}
