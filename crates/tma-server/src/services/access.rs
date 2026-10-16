//! Last-access times, coalesced the way NTFS and relatime do: a per-item
//! suppression window drops repeat reads for free, and a write-behind buffer
//! flushes the survivors as one bulk UPDATE per interval. Nothing here is
//! awaited on a request path or fails a request.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::settings::SettingsCache;

const MAX_PENDING: usize = 2000;
const CHUNK: usize = 500;
const MAX_SUPPRESSED: usize = 50_000;

#[derive(Default)]
struct Buffers {
    pending: HashMap<(String, String), DateTime<Utc>>,
    suppressed: HashMap<(String, String), Instant>,
}

#[derive(Clone)]
pub struct AccessTracker {
    pool: PgPool,
    settings: SettingsCache,
    buffers: Arc<Mutex<Buffers>>,
    flushing: Arc<Mutex<()>>,
}

impl AccessTracker {
    pub fn new(pool: PgPool, settings: SettingsCache) -> Self {
        Self { pool, settings, buffers: Arc::default(), flushing: Arc::default() }
    }

    /// Note that items were read on `owner_id`'s account.
    pub fn record<I: IntoIterator<Item = S>, S: AsRef<str>>(&self, ids: I, owner_id: &str) {
        let ids: Vec<String> = ids.into_iter().map(|s| s.as_ref().to_string()).filter(|s| !s.is_empty()).collect();
        if ids.is_empty() || owner_id.is_empty() {
            return;
        }
        let this = self.clone();
        let owner = owner_id.to_string();
        tokio::spawn(async move {
            let settings = this.settings.get().await.activity();
            if !settings.access_time_tracking {
                return;
            }
            let window = Duration::from_secs(settings.access_time_window_minutes as u64 * 60);
            let now = Instant::now();
            let should_flush = {
                let mut b = this.buffers.lock().await;
                for id in ids {
                    let key = (owner.clone(), id);
                    if b.suppressed.get(&key).is_some_and(|until| *until > now) {
                        continue;
                    }
                    b.suppressed.insert(key.clone(), now + window);
                    b.pending.insert(key, Utc::now());
                }
                if b.suppressed.len() > MAX_SUPPRESSED {
                    b.suppressed.retain(|_, until| *until > now);
                    if b.suppressed.len() > MAX_SUPPRESSED {
                        b.suppressed.clear();
                    }
                }
                b.pending.len() >= MAX_PENDING
            };
            if should_flush {
                this.flush().await;
            }
        });
    }

    pub fn record_one(&self, id: &str, owner_id: &str) {
        self.record([id], owner_id);
    }

    /// Write everything buffered; returns the rows actually updated.
    pub async fn flush(&self) -> u64 {
        let Ok(_guard) = self.flushing.try_lock() else { return 0 };
        let mut batch: Vec<((String, String), DateTime<Utc>)> = {
            let mut b = self.buffers.lock().await;
            b.pending.drain().collect()
        };
        if batch.is_empty() {
            return 0;
        }
        // Stable order so concurrent flushes from other processes lock in the same order.
        batch.sort_by(|a, b| a.0.cmp(&b.0));
        let mut written = 0;
        for chunk in batch.chunks(CHUNK) {
            let ids: Vec<&str> = chunk.iter().map(|((_, id), _)| id.as_str()).collect();
            let owners: Vec<&str> = chunk.iter().map(|((o, _), _)| o.as_str()).collect();
            let times: Vec<DateTime<Utc>> = chunk.iter().map(|(_, t)| *t).collect();
            let result = sqlx::query(
                "UPDATE files AS f SET accessed_at = v.accessed_at
                   FROM unnest($1::text[], $2::text[], $3::timestamptz[]) AS v(id, user_id, accessed_at)
                  WHERE f.id = v.id AND f.user_id = v.user_id AND f.deleted_at IS NULL AND f.accessed_at < v.accessed_at",
            )
            .bind(&ids)
            .bind(&owners)
            .bind(&times)
            .execute(&self.pool)
            .await;
            match result {
                Ok(r) => written += r.rows_affected(),
                Err(err) => {
                    // Nothing stored: forget the windows so the next read retries.
                    tracing::warn!(error = %err, count = chunk.len(), "[AccessTime] Failed to flush access times");
                    let mut b = self.buffers.lock().await;
                    for (key, _) in chunk {
                        b.suppressed.remove(key);
                    }
                }
            }
        }
        written
    }

    /// Flush on the configured interval for the life of the process.
    pub fn spawn_flusher(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                let secs = this.settings.get().await.activity().access_time_flush_seconds.max(1) as u64;
                tokio::time::sleep(Duration::from_secs(secs)).await;
                this.flush().await;
            }
        });
    }
}
