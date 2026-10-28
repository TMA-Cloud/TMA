//! Live file events. Every process holds one Redis connection pattern-subscribed
//! to all users' channels and fans messages out to its own SSE streams, so an
//! open tab costs a channel receiver, not a Redis socket.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::cache::Cache;

const CHANNEL_PREFIX: &str = "file:events:";
pub const MAX_CONNECTIONS: usize = 10_000;
const PING_EVERY: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(5);

pub mod types {
    pub const FILE_UPLOADED: &str = "file.uploaded";
    pub const FILE_DELETED: &str = "file.deleted";
    pub const FILE_RENAMED: &str = "file.renamed";
    pub const FILE_MOVED: &str = "file.moved";
    pub const FILE_COPIED: &str = "file.copied";
    pub const FOLDER_CREATED: &str = "folder.created";
    pub const FILE_RESTORED: &str = "file.restored";
    pub const FILE_PERMANENTLY_DELETED: &str = "file.permanently_deleted";
    pub const FILE_STARRED: &str = "file.starred";
    pub const FILE_SHARED: &str = "file.shared";
    pub const FILE_UPDATED: &str = "file.updated";
}

#[derive(Clone)]
pub struct EventHub {
    cache: Cache,
    subscribers: Arc<DashMap<String, broadcast::Sender<Arc<str>>>>,
    connections: Arc<AtomicUsize>,
}

/// An SSE subscription; dropping it releases the slot.
pub struct Subscription {
    pub rx: broadcast::Receiver<Arc<str>>,
    hub: EventHub,
    user_id: String,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.connections.fetch_sub(1, Ordering::Relaxed);
        // The last receiver gone: forget the user's sender.
        self.hub.subscribers.remove_if(&self.user_id, |_, tx| tx.receiver_count() <= 1);
    }
}

impl EventHub {
    pub fn new(cache: Cache) -> Self {
        Self { cache, subscribers: Arc::new(DashMap::new()), connections: Arc::new(AtomicUsize::new(0)) }
    }

    pub fn subscribe(&self, user_id: &str) -> Option<Subscription> {
        if self.connections.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            tracing::warn!("Maximum SSE connections reached");
            return None;
        }
        self.connections.fetch_add(1, Ordering::Relaxed);
        let rx = self.subscribers.entry(user_id.to_string()).or_insert_with(|| broadcast::channel(256).0).subscribe();
        Some(Subscription { rx, hub: self.clone(), user_id: user_id.to_string() })
    }

    fn deliver_local(&self, user_id: &str, message: &str) {
        if let Some(tx) = self.subscribers.get(user_id) {
            let _ = tx.send(Arc::from(message));
        }
    }

    // Without Redis this process's own streams still get the event.
    async fn send(&self, user_id: &str, message: String) {
        if !self.cache.publish(&format!("{CHANNEL_PREFIX}{user_id}"), &message).await {
            self.deliver_local(user_id, &message);
        }
    }

    /// Publish one event to an account's channel.
    pub async fn publish(&self, user_id: &str, event_type: &str, data: Value) {
        let message =
            json!({ "type": event_type, "timestamp": chrono::Utc::now().to_rfc3339(), "data": data }).to_string();
        self.send(user_id, message).await;
    }

    /// A file started or stopped being edited: lists and drives refresh (not on every renewal).
    pub async fn lock_changed(&self, owner: &str, file_id: &str) {
        self.publish(owner, types::FILE_UPDATED, json!({ "id": file_id, "userId": owner, "lock": true })).await;
    }

    /// Publish many events as one `file.batch` envelope per account; the client
    /// coalesces a burst into one refresh anyway.
    pub async fn publish_batch(&self, user_id: &str, events: Vec<(&str, Value)>) {
        if events.is_empty() {
            return;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let items: Vec<Value> =
            events.into_iter().map(|(t, d)| json!({ "type": t, "timestamp": now, "data": d })).collect();
        let message = json!({ "type": "file.batch", "timestamp": now, "data": { "events": items } }).to_string();
        self.send(user_id, message).await;
    }

    /// Keep the pattern subscription alive for the life of the process,
    /// routing file events locally and settings changes to `on_settings`.
    pub fn spawn_listener<F>(&self, on_settings: F)
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        let hub = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(err) = hub.listen(&on_settings).await {
                    tracing::warn!(error = %err, "File events subscriber disconnected; retrying");
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
    }

    async fn listen<F: Fn(String)>(&self, on_settings: &F) -> anyhow::Result<()> {
        let mut pubsub = self.cache.client().get_async_pubsub().await?;
        pubsub.psubscribe(format!("{CHANNEL_PREFIX}*")).await?;
        pubsub.subscribe(crate::settings::CHANGED_CHANNEL).await?;
        let (mut sink, mut messages) = pubsub.split();
        // A connection that died without closing never ends the stream, so ping it.
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            let msg = tokio::select! {
                msg = messages.next() => match msg {
                    Some(msg) => msg,
                    None => return Ok(()),
                },
                _ = ping.tick() => {
                    tokio::time::timeout(PING_TIMEOUT, sink.ping::<()>())
                        .await
                        .map_err(|_| anyhow::anyhow!("Redis did not answer a ping"))??;
                    continue;
                }
            };
            let channel = msg.get_channel_name().to_string();
            let Ok(payload) = msg.get_payload::<String>() else { continue };
            if let Some(user_id) = channel.strip_prefix(CHANNEL_PREFIX) {
                self.deliver_local(user_id, &payload);
            } else if channel == crate::settings::CHANGED_CHANNEL {
                on_settings(payload);
            }
        }
    }
}
