//! Edit locks (migrations 062, 063): a lease on a file while someone edits it in
//! a desktop app. Taking one renews it for the same person on the same install;
//! anyone else, the same person on another computer included, is told who holds
//! it. Expired leases count as free, so nothing needs sweeping.

use std::time::Duration;

use sqlx::PgPool;
use tma_core::api::FileLock;

/// How long a lock lasts unless renewed; the desktop app renews well inside it.
pub const LEASE: Duration = Duration::from_secs(120);

/// The live lock on a file, if any, with the holder's display name.
pub const HOLDER_SQL: &str =
    "SELECT l.user_id, COALESCE(NULLIF(u.name, ''), u.email) AS name, l.acquired_at, l.expires_at, l.device_id
       FROM file_locks l JOIN users u ON u.id = l.user_id
      WHERE l.file_id = $1 AND l.expires_at > NOW()";

#[derive(sqlx::FromRow)]
struct Row {
    user_id: String,
    name: String,
    acquired_at: chrono::DateTime<chrono::Utc>,
    expires_at: chrono::DateTime<chrono::Utc>,
    device_id: Option<String>,
}

impl From<Row> for FileLock {
    fn from(r: Row) -> Self {
        FileLock {
            user_id: r.user_id,
            name: r.name,
            since: r.acquired_at,
            expires_at: r.expires_at,
            device_id: r.device_id,
        }
    }
}

/// Who is acting: a user, and the desktop install they act from, if any.
#[derive(Clone, Copy)]
pub struct Actor<'a> {
    pub user: &'a str,
    pub device: Option<&'a str>,
}

impl Actor<'_> {
    /// Whether `lock` is this actor's own, taken from this same install.
    pub fn holds(&self, lock: &FileLock) -> bool {
        lock.user_id == self.user && lock.device_id.as_deref() == self.device
    }
}

/// What taking a lock came to.
pub enum Taken {
    /// The caller holds it now; `fresh` when it was not theirs a moment ago.
    Held { lock: FileLock, fresh: bool },
    /// Someone else is editing.
    Busy(FileLock),
}

pub async fn holder<'e, E: sqlx::PgExecutor<'e>>(db: E, file_id: &str) -> anyhow::Result<Option<FileLock>> {
    Ok(sqlx::query_as::<_, Row>(HOLDER_SQL).bind(file_id).fetch_optional(db).await?.map(Into::into))
}

/// Take or renew the lock on `file_id` (a file of `owner`'s) for `actor`, for `lease`.
pub async fn acquire(
    pool: &PgPool,
    file_id: &str,
    owner: &str,
    actor: Actor<'_>,
    lease: Duration,
) -> anyhow::Result<Option<Taken>> {
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND type = 'file' AND deleted_at IS NULL",
    )
    .bind(file_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    if exists.is_none() {
        return Ok(None);
    }
    let before = holder(pool, file_id).await?;
    // Only a free (or expired) lock, or the caller's own from the same install, is
    // taken; a renewal keeps its start.
    let taken: Option<String> = sqlx::query_scalar(
        "INSERT INTO file_locks (file_id, user_id, owner_id, expires_at, device_id)
         VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5)
         ON CONFLICT (file_id) DO UPDATE SET
            acquired_at = CASE WHEN file_locks.user_id = EXCLUDED.user_id
                                AND file_locks.device_id IS NOT DISTINCT FROM EXCLUDED.device_id
                                AND file_locks.expires_at > NOW()
                               THEN file_locks.acquired_at ELSE NOW() END,
            user_id = EXCLUDED.user_id, owner_id = EXCLUDED.owner_id,
            expires_at = EXCLUDED.expires_at, device_id = EXCLUDED.device_id
          WHERE (file_locks.user_id = EXCLUDED.user_id
                 AND file_locks.device_id IS NOT DISTINCT FROM EXCLUDED.device_id)
             OR file_locks.expires_at <= NOW()
         RETURNING file_id",
    )
    .bind(file_id)
    .bind(actor.user)
    .bind(owner)
    .bind(lease.as_secs_f64())
    .bind(actor.device)
    .fetch_optional(pool)
    .await?;
    let now = holder(pool, file_id).await?;
    Ok(Some(match (taken, now) {
        (Some(_), Some(lock)) => {
            let fresh = before.is_none_or(|b| !actor.holds(&b));
            Taken::Held { lock, fresh }
        }
        (_, Some(lock)) => Taken::Busy(lock),
        (_, None) => anyhow::bail!("the lock vanished as it was taken"),
    }))
}

/// Extend the live lock `device` holds on a file, whoever took it there.
pub async fn renew_device(pool: &PgPool, file_id: &str, device: &str, lease: Duration) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE file_locks SET expires_at = NOW() + make_interval(secs => $3)
          WHERE file_id = $1 AND device_id = $2 AND expires_at > NOW()",
    )
    .bind(file_id)
    .bind(device)
    .bind(lease.as_secs_f64())
    .execute(pool)
    .await?;
    Ok(())
}

/// Drop the lock `device` holds on a file; true when there was a live one.
pub async fn release_device(pool: &PgPool, file_id: &str, device: &str) -> anyhow::Result<bool> {
    let done = sqlx::query("DELETE FROM file_locks WHERE file_id = $1 AND device_id = $2 AND expires_at > NOW()")
        .bind(file_id)
        .bind(device)
        .execute(pool)
        .await?;
    Ok(done.rows_affected() > 0)
}

/// Give up `actor`'s lock on a file; true when there was one to give up.
pub async fn release(pool: &PgPool, file_id: &str, actor: Actor<'_>) -> anyhow::Result<bool> {
    let done = sqlx::query(
        "DELETE FROM file_locks WHERE file_id = $1 AND user_id = $2
            AND device_id IS NOT DISTINCT FROM $3 AND expires_at > NOW()",
    )
    .bind(file_id)
    .bind(actor.user)
    .bind(actor.device)
    .execute(pool)
    .await?;
    Ok(done.rows_affected() > 0)
}
