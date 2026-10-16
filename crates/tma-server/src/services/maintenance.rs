//! Scheduled housekeeping the worker runs.

use sqlx::PgPool;

/// Audit rows past the 30-day retention, deleted 10,000 at a time.
pub async fn cleanup_audit_log(pool: &PgPool) -> anyhow::Result<i64> {
    let mut total = 0;
    for _ in 0..20 {
        let deleted: i32 = sqlx::query_scalar("SELECT cleanup_old_audit_logs(30)").fetch_one(pool).await?;
        total += deleted as i64;
        if deleted < 10_000 {
            break;
        }
    }
    tracing::info!(deleted = total, "Audit log cleanup completed");
    Ok(total)
}

/// Rows deleted by a bounded batch loop over `sql` (which takes `$1` as the batch size).
async fn batched_delete(pool: &PgPool, sql: &'static str, extra: f64) -> anyhow::Result<u64> {
    let mut total = 0;
    for _ in 0..20 {
        let deleted = sqlx::query(sql).bind(5000i64).bind(extra).execute(pool).await?.rows_affected();
        total += deleted;
        if deleted < 5000 {
            break;
        }
    }
    Ok(total)
}

/// Idempotency records of finished copy jobs, once the jobs are long gone.
pub async fn cleanup_operation_results(pool: &PgPool) -> anyhow::Result<u64> {
    batched_delete(
        pool,
        "WITH doomed AS (SELECT job_id FROM file_operation_results WHERE completed_at < NOW() - INTERVAL '1 day' * $2
                          ORDER BY completed_at, job_id LIMIT $1)
         DELETE FROM file_operation_results r USING doomed WHERE r.job_id = doomed.job_id",
        30.0,
    )
    .await
}

/// Manifests left by a bulk import that was killed mid-run; only old rows, never one in flight.
pub async fn cleanup_import_manifests(pool: &PgPool) -> anyhow::Result<u64> {
    let deleted = batched_delete(
        pool,
        "WITH doomed AS (SELECT run_id, file_id FROM bulk_import_items WHERE created_at < NOW() - INTERVAL '1 day' * $2
                          ORDER BY created_at, run_id LIMIT $1)
         DELETE FROM bulk_import_items i USING doomed WHERE i.run_id = doomed.run_id AND i.file_id = doomed.file_id",
        7.0,
    )
    .await?;
    if deleted > 0 {
        tracing::info!(deleted, "Purged stale bulk-import manifests");
    }
    Ok(deleted)
}

/// Expired quota reservations (a job that died without releasing its hold).
pub async fn cleanup_reservations(pool: &PgPool) -> anyhow::Result<u64> {
    let mut total = 0;
    for _ in 0..100 {
        let deleted = sqlx::query(
            "WITH expired AS (SELECT id FROM storage_reservations WHERE expires_at <= NOW() ORDER BY expires_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED)
             DELETE FROM storage_reservations r USING expired e WHERE r.id = e.id",
        )
        .execute(pool)
        .await?
        .rows_affected();
        total += deleted;
        if deleted < 1000 {
            break;
        }
    }
    Ok(total)
}

/// Recompute folder aggregates per account and report drift (it should be zero).
pub async fn reconcile_folder_aggregates(pool: &PgPool) -> anyhow::Result<(usize, i64)> {
    let started = std::time::Instant::now();
    let accounts: Vec<String> = sqlx::query_scalar("SELECT id FROM users ORDER BY id").fetch_all(pool).await?;
    let (mut scanned, mut repaired) = (0, 0i64);
    for id in &accounts {
        if started.elapsed() > std::time::Duration::from_secs(20 * 60) {
            break;
        }
        let drifted: i32 =
            sqlx::query_scalar("SELECT reconcile_folder_aggregates($1)").bind(id).fetch_one(pool).await?;
        scanned += 1;
        repaired += drifted as i64;
        if drifted > 0 {
            tracing::warn!(user_id = %id, folders = drifted, "Repaired drifted folder aggregates");
        }
    }
    tracing::info!(scanned, accounts = accounts.len(), repaired, "Folder aggregate reconciliation completed");
    Ok((scanned, repaired))
}
