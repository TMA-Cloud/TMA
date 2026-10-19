//! The folder change feed (migration 065): which folders' listings changed since
//! a client's cursor, so a desktop app re-lists those instead of all it has open.

use sqlx::PgPool;
use tma_core::api::Changes;

/// Past this many folders a full resync is cheaper than one listing each.
const MAX_FOLDERS: i64 = 1000;
/// How long changes are kept; a cursor older than that starts over.
const KEEP_DAYS: f64 = 7.0;

/// What changed for `owner` since `cursor`. The new cursor is the oldest
/// transaction still running: everything before it is final, so nothing can
/// appear behind it later. Changes already committed past it are returned too,
/// and may come again on the next call; re-listing a folder twice is harmless.
pub async fn since(pool: &PgPool, owner: &str, cursor: Option<&str>) -> anyhow::Result<Changes> {
    let since = cursor.and_then(|c| c.parse::<u64>().ok());
    let (horizon, floor, folders): (String, String, Option<Vec<Option<String>>>) = sqlx::query_as(
        "SELECT pg_snapshot_xmin(pg_current_snapshot())::text,
                (SELECT xid::text FROM file_change_floor),
                (SELECT array_agg(folder_id) FROM (
                   SELECT DISTINCT folder_id FROM file_changes
                    WHERE owner_id = $1 AND xid >= $2::text::xid8 LIMIT $3) c)",
    )
    .bind(owner)
    .bind(since.unwrap_or(u64::MAX).min(i64::MAX as u64).to_string())
    .bind(MAX_FOLDERS + 1)
    .fetch_one(pool)
    .await?;
    let floor = floor.parse::<u64>().unwrap_or(0);
    let folders = folders.unwrap_or_default();
    let reset = match since {
        None => true,
        Some(since) => since <= floor || folders.len() as i64 > MAX_FOLDERS,
    };
    Ok(Changes { cursor: horizon, folders: if reset { Vec::new() } else { folders }, reset })
}

/// Drop changes older than a week, raising the floor so a cursor from before
/// the dropped ones resyncs in full instead of missing them.
pub async fn prune(pool: &PgPool) -> anyhow::Result<u64> {
    let mut total = 0;
    for _ in 0..20 {
        let (deleted,): (i64,) = sqlx::query_as(
            "WITH doomed AS (SELECT ctid FROM file_changes WHERE changed_at < NOW() - INTERVAL '1 day' * $2 LIMIT $1),
                  gone AS (DELETE FROM file_changes c USING doomed WHERE c.ctid = doomed.ctid RETURNING c.xid),
                  raised AS (UPDATE file_change_floor SET xid = GREATEST(xid, (SELECT max(xid) FROM gone))
                              WHERE EXISTS (SELECT 1 FROM gone) RETURNING 1)
             SELECT (SELECT count(*) FROM gone) + 0 * (SELECT count(*) FROM raised)",
        )
        .bind(5000i64)
        .bind(KEEP_DAYS)
        .fetch_one(pool)
        .await?;
        total += deleted as u64;
        if deleted < 5000 {
            break;
        }
    }
    Ok(total)
}
