//! Edit locks (migration 062): a lease on a file while someone edits it in a
//! desktop app. Taking one renews it for the same person; anyone else is told
//! who holds it. Expired leases count as free, so nothing needs sweeping.

use std::time::Duration;

use sqlx::PgPool;
use tma_core::api::FileLock;

/// How long a lock lasts unless renewed; the desktop app renews well inside it.
pub const LEASE: Duration = Duration::from_secs(120);

/// The live lock on a file, if any, with the holder's display name.
pub const HOLDER_SQL: &str =
    "SELECT l.user_id, COALESCE(NULLIF(u.name, ''), u.email) AS name, l.acquired_at, l.expires_at
       FROM file_locks l JOIN users u ON u.id = l.user_id
      WHERE l.file_id = $1 AND l.expires_at > NOW()";

#[derive(sqlx::FromRow)]
struct Row {
    user_id: String,
    name: String,
    acquired_at: chrono::DateTime<chrono::Utc>,
    expires_at: chrono::DateTime<chrono::Utc>,
}

impl From<Row> for FileLock {
    fn from(r: Row) -> Self {
        FileLock { user_id: r.user_id, name: r.name, since: r.acquired_at, expires_at: r.expires_at }
    }
}

/// What taking a lock came to.
pub enum Taken {
    /// The caller holds it now; `fresh` when it was not theirs a moment ago.
    Held { lock: FileLock, fresh: bool },
    /// Someone else is editing.
    Busy(FileLock),
}

pub async fn holder(pool: &PgPool, file_id: &str) -> anyhow::Result<Option<FileLock>> {
    Ok(sqlx::query_as::<_, Row>(HOLDER_SQL).bind(file_id).fetch_optional(pool).await?.map(Into::into))
}

/// Take or renew the lock on `file_id` (a file of `owner`'s) for `user`.
pub async fn acquire(pool: &PgPool, file_id: &str, owner: &str, user: &str) -> anyhow::Result<Option<Taken>> {
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
    // Only a free (or expired) lock, or the caller's own, is taken; a renewal keeps its start.
    let taken: Option<String> = sqlx::query_scalar(
        "INSERT INTO file_locks (file_id, user_id, owner_id, expires_at)
         VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))
         ON CONFLICT (file_id) DO UPDATE SET
            acquired_at = CASE WHEN file_locks.user_id = EXCLUDED.user_id AND file_locks.expires_at > NOW()
                               THEN file_locks.acquired_at ELSE NOW() END,
            user_id = EXCLUDED.user_id, owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at
          WHERE file_locks.user_id = EXCLUDED.user_id OR file_locks.expires_at <= NOW()
         RETURNING file_id",
    )
    .bind(file_id)
    .bind(user)
    .bind(owner)
    .bind(LEASE.as_secs_f64())
    .fetch_optional(pool)
    .await?;
    let now = holder(pool, file_id).await?;
    Ok(Some(match (taken, now) {
        (Some(_), Some(lock)) => {
            let fresh = before.is_none_or(|b| b.user_id != user);
            Taken::Held { lock, fresh }
        }
        (_, Some(lock)) => Taken::Busy(lock),
        (_, None) => anyhow::bail!("the lock vanished as it was taken"),
    }))
}

/// Give up `user`'s lock on a file; true when there was one to give up.
pub async fn release(pool: &PgPool, file_id: &str, user: &str) -> anyhow::Result<bool> {
    let done = sqlx::query("DELETE FROM file_locks WHERE file_id = $1 AND user_id = $2 AND expires_at > NOW()")
        .bind(file_id)
        .bind(user)
        .execute(pool)
        .await?;
    Ok(done.rows_affected() > 0)
}
