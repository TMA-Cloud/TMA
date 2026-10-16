//! Cron schedules: the worker enqueues one job per due occurrence. Claiming a
//! schedule row with SKIP LOCKED makes two workers fire each occurrence once.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;

use super::{JobQueue, queues};

/// Maintenance tasks and their (UTC) crontab lines, spread so they never pile up.
pub const MAINTENANCE: [(&str, &str); 9] = [
    ("cleanup-expired-trash", "0 2 * * *"),
    ("cleanup-audit-log", "40 3 * * *"),
    ("cleanup-old-sessions", "20 4 * * *"),
    ("cleanup-file-operation-results", "50 4 * * *"),
    ("cleanup-bulk-import-manifests", "25 5 * * *"),
    ("reconcile-folder-aggregates", "15 1 * * Sun"),
    ("cleanup-expired-share-links", "10 6 * * Sun"),
    ("cleanup-client-heartbeats", "7 * * * *"),
    ("cleanup-storage-reservations", "37 * * * *"),
];

/// A five-field crontab line as the six-field form the cron crate parses.
fn parse(cron: &str) -> Option<cron::Schedule> {
    let fields = cron.split_whitespace().count();
    let six = if fields == 5 { format!("0 {cron}") } else { cron.to_string() };
    cron::Schedule::from_str(&six).ok()
}

/// The first occurrence after `after`.
pub fn next_after(cron: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    parse(cron)?.after(&after).next()
}

/// Register the built-in maintenance schedules (idempotent).
pub async fn register_maintenance(queue: &JobQueue) -> anyhow::Result<()> {
    for (task, cron) in MAINTENANCE {
        queue.schedule(task, queues::MAINTENANCE, cron, json!({ "task": task })).await?;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct ScheduleRow {
    name: String,
    queue: String,
    cron: String,
    data: Value,
    last_run_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

/// Enqueue every schedule whose next occurrence has come; returns how many fired.
pub async fn fire_due(pool: &PgPool, queue: &JobQueue) -> anyhow::Result<usize> {
    let now = Utc::now();
    let mut fired = 0;
    let mut tx = pool.begin().await?;
    let rows = sqlx::query_as::<_, ScheduleRow>(
        "SELECT name, queue, cron, data, last_run_at, created_at FROM job_schedules FOR UPDATE SKIP LOCKED",
    )
    .fetch_all(&mut *tx)
    .await?;
    for row in rows {
        let from = row.last_run_at.unwrap_or(row.created_at);
        let Some(due) = next_after(&row.cron, from) else {
            tracing::warn!(name = %row.name, cron = %row.cron, "Invalid cron schedule");
            continue;
        };
        if due > now {
            continue;
        }
        // Missed occurrences collapse into one run; the key keeps a slow job from stacking.
        queue.send_unique(&row.queue, row.data.clone(), &row.name).await?;
        sqlx::query("UPDATE job_schedules SET last_run_at = $2 WHERE name = $1")
            .bind(&row.name)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        fired += 1;
    }
    tx.commit().await?;
    Ok(fired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn crontab_lines() {
        for (_, cron) in MAINTENANCE {
            assert!(parse(cron).is_some(), "{cron}");
        }
        let from = Utc.with_ymd_and_hms(2026, 1, 1, 1, 0, 0).single().unwrap();
        assert_eq!(next_after("0 2 * * *", from), Utc.with_ymd_and_hms(2026, 1, 1, 2, 0, 0).single());
        assert_eq!(next_after("*/5 * * * *", from), Utc.with_ymd_and_hms(2026, 1, 1, 1, 5, 0).single());
    }
}
