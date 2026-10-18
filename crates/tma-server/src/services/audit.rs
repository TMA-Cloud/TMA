//! The audit trail. Requests hand events to an in-process channel and never
//! wait; a writer task batches them into one multi-row INSERT per flush, which
//! costs one round trip where a queue would cost three.

use std::time::Duration;

use serde_json::{Map, Value};
use sqlx::PgPool;
use tokio::sync::{mpsc, oneshot};

use crate::middleware::ReqCtx;
use crate::services::metrics::Metrics;

const CHANNEL_CAPACITY: usize = 10_000;
const BATCH: usize = 200;
const FLUSH_EVERY: Duration = Duration::from_millis(500);

/// One audited action.
#[derive(Debug, Clone)]
pub struct Event {
    pub action: String,
    pub status: &'static str,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub metadata: Option<Value>,
    pub error_message: Option<String>,
    pub actor_user_id: Option<String>,
    pub account_owner_id: Option<String>,
    pub actor_role: Option<String>,
}

impl Event {
    pub fn new(action: &str) -> Self {
        Self {
            action: action.into(),
            status: "success",
            resource_type: None,
            resource_id: None,
            metadata: None,
            error_message: None,
            actor_user_id: None,
            account_owner_id: None,
            actor_role: None,
        }
    }

    pub fn failure(mut self) -> Self {
        self.status = "failure";
        self
    }

    pub fn resource(mut self, kind: &str, id: Option<&str>) -> Self {
        self.resource_type = Some(kind.into());
        self.resource_id = id.map(String::from);
        self
    }

    pub fn meta(mut self, metadata: Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    pub fn error(mut self, message: &str) -> Self {
        self.error_message = Some(message.into());
        self
    }

    /// Identity for events logged before the auth middleware ran (login, signup).
    pub fn actor(mut self, user_id: &str, owner_id: &str, role: &str) -> Self {
        self.actor_user_id = Some(user_id.into());
        self.account_owner_id = Some(owner_id.into());
        self.actor_role = Some(role.into());
        self
    }
}

struct Row {
    request_id: String,
    user_id: Option<String>,
    owner_id: Option<String>,
    role: Option<String>,
    event: Event,
    ip: Option<String>,
    user_agent: Option<String>,
}

enum Msg {
    Row(Box<Row>),
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct AuditLog {
    tx: mpsc::Sender<Msg>,
}

const SENSITIVE: &[&str] = &[
    "password",
    "token",
    "secret",
    "authorization",
    "cookie",
    "jwt",
    "access_token",
    "refresh_token",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "api_key",
    "client_secret",
    "clientsecret",
    "auth",
    "bearer",
    "connectionstring",
    "db_password",
    "jwt_secret",
    "onlyoffice_jwt_secret",
];

/// Remove credentials and partially mask emails before anything reaches the log.
pub fn redact(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, v) in map {
                let lower = key.to_ascii_lowercase();
                let redacted = if SENSITIVE.iter().any(|s| lower.contains(s)) {
                    Value::String("[REDACTED]".into())
                } else if key == "email" {
                    match v.as_str().and_then(|e| e.split_once('@')) {
                        Some((local, domain)) if !local.is_empty() => {
                            let first = local.chars().next().unwrap_or('*');
                            let last = local.chars().last().unwrap_or('*');
                            Value::String(format!("{first}***{last}@{domain}"))
                        }
                        _ => v.clone(),
                    }
                } else {
                    redact(v)
                };
                out.insert(key.clone(), redacted);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact).collect()),
        other => other.clone(),
    }
}

impl AuditLog {
    pub fn start(pool: PgPool, metrics: Metrics) -> Self {
        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        tokio::spawn(writer(pool, metrics, rx));
        Self { tx }
    }

    /// Record an event; never blocks the request. A full channel falls back to the app log.
    pub fn log(&self, ctx: &ReqCtx, event: Event) {
        let row = Row {
            request_id: if ctx.request_id.is_empty() { "unknown".into() } else { ctx.request_id.clone() },
            user_id: event.actor_user_id.clone().or_else(|| ctx.user_id.clone()),
            owner_id: event.account_owner_id.clone().or_else(|| ctx.owner_id.clone()).or_else(|| ctx.user_id.clone()),
            role: event.actor_role.clone().or_else(|| ctx.role.map(String::from)),
            ip: ctx.ip.clone(),
            user_agent: ctx.user_agent.clone(),
            event,
        };
        if let Err(err) = self.tx.try_send(Msg::Row(Box::new(row)))
            && let mpsc::error::TrySendError::Full(Msg::Row(row)) | mpsc::error::TrySendError::Closed(Msg::Row(row)) =
                err
        {
            tracing::warn!(action = %row.event.action, "Audit queue unavailable, event logged to application log only");
        }
    }

    /// Write everything queued so far (graceful shutdown).
    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Msg::Flush(tx)).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
        }
    }
}

async fn writer(pool: PgPool, metrics: Metrics, mut rx: mpsc::Receiver<Msg>) {
    let mut batch: Vec<Row> = Vec::with_capacity(BATCH);
    loop {
        let msg = tokio::time::timeout(FLUSH_EVERY, rx.recv()).await;
        let mut ack = None;
        match msg {
            Ok(Some(Msg::Row(row))) => {
                batch.push(*row);
                if batch.len() < BATCH {
                    continue;
                }
            }
            Ok(Some(Msg::Flush(done))) => ack = Some(done),
            Ok(None) => {
                write_batch(&pool, &metrics, &mut batch).await;
                return;
            }
            Err(_) => {}
        }
        write_batch(&pool, &metrics, &mut batch).await;
        if let Some(done) = ack {
            let _ = done.send(());
        }
    }
}

async fn insert(pool: &PgPool, rows: &[Row], strip_users: bool) -> Result<(), sqlx::Error> {
    let mut builder = sqlx::QueryBuilder::new(
        "INSERT INTO audit_log (request_id, user_id, account_owner_id, actor_role, action, resource_type, resource_id,
           status, ip_address, user_agent, metadata, error_message, processing_time_ms) ",
    );
    builder.push_values(rows.iter(), |mut b, row| {
        let (user, owner) = if strip_users { (None, None) } else { (row.user_id.clone(), row.owner_id.clone()) };
        b.push_bind(row.request_id.clone())
            .push_bind(user)
            .push_bind(owner)
            .push_bind(row.role.clone())
            .push_bind(row.event.action.clone())
            .push_bind(row.event.resource_type.clone())
            .push_bind(row.event.resource_id.clone())
            .push_bind(row.event.status)
            .push_bind(row.ip.clone())
            .push_unseparated("::inet")
            .push_bind(row.user_agent.clone())
            .push_bind(row.event.metadata.as_ref().map(redact))
            .push_bind(row.event.error_message.clone())
            .push_bind(None::<i32>);
    });
    builder.build().execute(pool).await.map(|_| ())
}

async fn write_batch(pool: &PgPool, metrics: &Metrics, batch: &mut Vec<Row>) {
    if batch.is_empty() {
        return;
    }
    let started = std::time::Instant::now();
    let count = batch.len();
    match insert(pool, batch, false).await {
        Ok(()) => metrics.audit_processed(count, started.elapsed().as_secs_f64()),
        Err(err) => {
            // One row can sink the batch (a user deleted before the flush breaks
            // the foreign key), so retry each alone, then without the identity.
            tracing::warn!(error = %err, count, "Audit batch failed; retrying row by row");
            for row in batch.iter() {
                let single = std::slice::from_ref(row);
                if insert(pool, single, false).await.is_ok() || insert(pool, single, true).await.is_ok() {
                    metrics.audit_processed(1, started.elapsed().as_secs_f64());
                } else {
                    tracing::error!(action = %row.event.action, "Failed to write audit event");
                    metrics.audit_failed(1, "database_error");
                }
            }
        }
    }
    batch.clear();
}
