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
/// Longest lifetime of a cache entry; prefix registries outlive it, so none expires before its keys.
const MAX_TTL: u64 = DEFAULT_TTL * 2;

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
            conn.get(key).await.map_err(|e| tracing::warn!(error = %e, key, "Error getting from cache")).ok()?;
        raw.and_then(|s| serde_json::from_str(&s).ok())
    }

    pub async fn set<T: Serialize + ?Sized>(&self, key: &str, value: &T, ttl: u64) {
        let Some(mut conn) = self.conn().await else { return };
        let Ok(text) = serde_json::to_string(value) else { return };
        let ttl = ttl.min(MAX_TTL);
        let prefixes = registry_prefixes(key);
        let mut pipe = redis::pipe();
        pipe.set_ex(key, text, ttl).ignore();
        let now = now_ms();
        for prefix in prefixes {
            let registry = format!("{REGISTRY}{prefix}");
            pipe.zadd(&registry, key, now + ttl as i64 * 1000).ignore();
            pipe.zrembyscore(&registry, 0, now).ignore();
            pipe.expire(&registry, MAX_TTL as i64 + 60).ignore();
        }
        if let Err(err) = pipe.query_async::<()>(&mut conn).await {
            tracing::warn!(error = %err, key, "Error setting cache");
        }
    }

    pub async fn delete(&self, key: &str) {
        let Some(mut conn) = self.conn().await else { return };
        let _: Result<(), _> = conn.del(key).await;
    }

    pub async fn delete_many(&self, keys: &[String]) {
        if keys.is_empty() {
            return;
        }
        let Some(mut conn) = self.conn().await else { return };
        let _: Result<(), _> = conn.unlink(keys).await;
    }

    /// Delete every live key starting with `prefix`, found through its registry
    /// rather than a keyspace scan.
    pub async fn delete_prefix(&self, prefix: &str) {
        let Some(registry_prefix) = registry_prefixes(prefix).into_iter().next() else { return };
        let Some(mut conn) = self.conn().await else { return };
        let registry = format!("{REGISTRY}{registry_prefix}");
        let now = now_ms();
        let _: Result<(), _> = conn.zrembyscore(&registry, 0, now).await;
        let keys: Vec<String> = conn.zrangebyscore(&registry, now, "+inf").await.unwrap_or_default();
        let matching: Vec<String> = keys.iter().filter(|k| k.starts_with(prefix)).cloned().collect();
        if matching.is_empty() {
            return;
        }
        let _: Result<(), _> = conn.unlink(&matching).await;
        // Removes only what was read, so a key registered meanwhile stays findable.
        let _: Result<(), _> = conn.zrem(&registry, &matching).await;
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

const REGISTRY: &str = "__cache_index_v2__:";

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The registries a key is indexed under, so a prefix can be invalidated.
fn registry_prefixes(key: &str) -> Vec<String> {
    let parts: Vec<&str> = key.split(':').collect();
    match parts.as_slice() {
        [ns @ ("session" | "user"), id, ..] if !id.is_empty() => {
            vec![format!("{ns}:{id}")]
        }
        _ => Vec::new(),
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
    pub fn session_prefix(user_id: &str) -> String {
        format!("session:{user_id}:")
    }
    pub fn user_prefix(user_id: &str) -> String {
        format!("user:{user_id}:")
    }
    pub fn setting(name: &str) -> String {
        format!("app:{name}")
    }
    pub fn share_by_token(token: &str) -> String {
        format!("share:token:{token}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registries() {
        assert_eq!(registry_prefixes("user:abc:account"), vec!["user:abc"]);
        assert_eq!(registry_prefixes("session:u1:s1:2"), vec!["session:u1"]);
        assert!(registry_prefixes("app:signup_enabled").is_empty());
    }
}
