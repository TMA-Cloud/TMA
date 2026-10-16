//! The durable background job queue in Postgres (migration 055). A job is
//! committed with the request that created it; workers claim rows with
//! FOR UPDATE SKIP LOCKED and are woken by NOTIFY. A singleton key keeps one
//! account's file operations in strict FIFO order and de-duplicates schedules.

pub mod handlers;
pub mod schedule;
pub mod worker;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub const NOTIFY_CHANNEL: &str = "tma_jobs";

pub mod queues {
    pub const MAINTENANCE: &str = "background-maintenance";
    pub const ONLYOFFICE_FORCESAVE: &str = "onlyoffice-forcesave";
    pub const ORPHANS: &str = "orphan-maintenance";
    pub const FILE_OPERATIONS: &str = "account-file-operations";
    pub const OBJECT_CLEANUP: &str = "object-cleanup";
    pub const SHARE_LINKING: &str = "share-linking";
    pub const ALL: [&str; 6] =
        [MAINTENANCE, ONLYOFFICE_FORCESAVE, ORPHANS, FILE_OPERATIONS, OBJECT_CLEANUP, SHARE_LINKING];
}

/// Retry and retention policy of a queue.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub retry_limit: i32,
    pub retry_delay: i32,
    pub backoff: bool,
    pub retry_delay_max: i32,
    pub expire_seconds: i32,
    pub keep_seconds: i32,
    /// Jobs worked at once by one worker process.
    pub concurrency: usize,
}

pub fn policy(queue: &str) -> Policy {
    const DAY: i32 = 86_400;
    match queue {
        queues::MAINTENANCE => Policy {
            retry_limit: 3,
            retry_delay: 60,
            backoff: true,
            retry_delay_max: 3600,
            expire_seconds: 3600,
            keep_seconds: 7 * DAY,
            concurrency: 1,
        },
        queues::ONLYOFFICE_FORCESAVE => Policy {
            retry_limit: 3,
            retry_delay: 60,
            backoff: true,
            retry_delay_max: 3600,
            expire_seconds: 300,
            keep_seconds: DAY,
            concurrency: 4,
        },
        queues::ORPHANS => Policy {
            retry_limit: 2,
            retry_delay: 60,
            backoff: true,
            retry_delay_max: 3600,
            expire_seconds: 3600,
            keep_seconds: DAY,
            concurrency: 1,
        },
        queues::FILE_OPERATIONS => Policy {
            retry_limit: 3,
            retry_delay: 30,
            backoff: true,
            retry_delay_max: 1800,
            expire_seconds: 6 * 3600,
            keep_seconds: DAY,
            concurrency: 4,
        },
        queues::SHARE_LINKING => Policy {
            retry_limit: 5,
            retry_delay: 15,
            backoff: true,
            retry_delay_max: 900,
            expire_seconds: 900,
            keep_seconds: 3600,
            concurrency: 4,
        },
        _ => Policy {
            retry_limit: 5,
            retry_delay: 30,
            backoff: true,
            retry_delay_max: 3600,
            expire_seconds: 1800,
            keep_seconds: DAY,
            concurrency: 4,
        },
    }
}

/// A claimed job.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Job {
    pub id: Uuid,
    pub queue: String,
    pub data: Value,
    pub singleton_key: Option<String>,
    pub retry_count: i32,
}

/// A job's state as reported to the client that queued it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct JobState {
    pub id: Uuid,
    pub state: String,
    pub data: Value,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct JobQueue {
    pool: PgPool,
}

impl JobQueue {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Queue a job; it is durable once this returns.
    pub async fn send(
        &self,
        queue: &str,
        data: Value,
        singleton_key: Option<&str>,
        delay_secs: i64,
    ) -> anyhow::Result<Uuid> {
        let p = policy(queue);
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO job_queue (id, queue, data, singleton_key, retry_limit, retry_delay_seconds, retry_backoff,
               retry_delay_max_seconds, expire_seconds, keep_seconds, start_after)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + make_interval(secs => $11))",
        )
        .bind(id)
        .bind(queue)
        .bind(&data)
        .bind(singleton_key)
        .bind(p.retry_limit)
        .bind(p.retry_delay)
        .bind(p.backoff)
        .bind(p.retry_delay_max)
        .bind(p.expire_seconds)
        .bind(p.keep_seconds)
        .bind(delay_secs as f64)
        .execute(&self.pool)
        .await?;
        let _ = sqlx::query("SELECT pg_notify($1, $2)").bind(NOTIFY_CHANNEL).bind(queue).execute(&self.pool).await;
        Ok(id)
    }

    /// Queue a job unless one with the same key is already waiting or running.
    pub async fn send_unique(&self, queue: &str, data: Value, key: &str) -> anyhow::Result<Option<Uuid>> {
        let busy: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM job_queue WHERE queue = $1 AND singleton_key = $2 AND state IN ('created', 'active') LIMIT 1",
        )
        .bind(queue)
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        if busy.is_some() {
            return Ok(None);
        }
        Ok(Some(self.send(queue, data, Some(key), 0).await?))
    }

    pub async fn get(&self, queue: &str, id: Uuid) -> anyhow::Result<Option<JobState>> {
        Ok(sqlx::query_as::<_, JobState>(
            "SELECT id, state, data, output, error, completed_at FROM job_queue WHERE id = $1 AND queue = $2",
        )
        .bind(id)
        .bind(queue)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Claim up to `limit` ready jobs. A keyed job is only ready when no job with
    /// its key is active and no older job with its key is still waiting.
    pub async fn claim(&self, queue: &str, limit: i64) -> anyhow::Result<Vec<Job>> {
        Ok(sqlx::query_as::<_, Job>(
            "WITH next AS (
               SELECT j.id FROM job_queue j
                WHERE j.queue = $1 AND j.state = 'created' AND j.start_after <= NOW()
                  AND (j.singleton_key IS NULL OR NOT EXISTS (
                        SELECT 1 FROM job_queue o
                         WHERE o.queue = j.queue AND o.singleton_key = j.singleton_key
                           AND (o.state = 'active' OR (o.state = 'created' AND o.created_at < j.created_at))))
                ORDER BY j.created_at
                LIMIT $2
                FOR UPDATE SKIP LOCKED
             )
             UPDATE job_queue SET state = 'active', started_at = NOW()
               FROM next WHERE job_queue.id = next.id
             RETURNING job_queue.id, job_queue.queue, job_queue.data, job_queue.singleton_key, job_queue.retry_count",
        )
        .bind(queue)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn complete(&self, id: Uuid, output: Option<Value>) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE job_queue SET state = 'completed', completed_at = NOW(), output = $2, error = NULL WHERE id = $1",
        )
        .bind(id)
        .bind(output)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Retry with (exponential) backoff, or mark the job failed once retries run out.
    pub async fn fail(&self, id: Uuid, error: &str) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE job_queue SET
               state = CASE WHEN retry_count < retry_limit THEN 'created' ELSE 'failed' END,
               completed_at = CASE WHEN retry_count < retry_limit THEN NULL ELSE NOW() END,
               start_after = NOW() + make_interval(secs => LEAST(retry_delay_max_seconds,
                 CASE WHEN retry_backoff THEN retry_delay_seconds * POWER(2, retry_count) ELSE retry_delay_seconds END)),
               retry_count = retry_count + 1,
               started_at = NULL,
               error = $2
             WHERE id = $1",
        )
        .bind(id)
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Jobs left active past their expiry (a worker died) go back to waiting.
    pub async fn expire_stale(&self) -> anyhow::Result<u64> {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM job_queue WHERE state = 'active' AND started_at < NOW() - make_interval(secs => expire_seconds)",
        )
        .fetch_all(&self.pool)
        .await?;
        for id in &ids {
            self.fail(*id, "job expired").await?;
        }
        Ok(ids.len() as u64)
    }

    /// Drop finished rows past their retention.
    pub async fn purge_finished(&self) -> anyhow::Result<u64> {
        Ok(sqlx::query(
            "DELETE FROM job_queue WHERE state IN ('completed', 'failed', 'cancelled')
               AND completed_at < NOW() - make_interval(secs => keep_seconds)",
        )
        .execute(&self.pool)
        .await?
        .rows_affected())
    }

    /// Waiting and failed counts per queue, for the metrics endpoint.
    pub async fn depths(&self) -> anyhow::Result<Vec<(String, String, i64)>> {
        Ok(sqlx::query_as(
            "SELECT queue, state, COUNT(*) FROM job_queue WHERE state IN ('created', 'failed') GROUP BY queue, state",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Create or replace a cron schedule.
    pub async fn schedule(&self, name: &str, queue: &str, cron: &str, data: Value) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO job_schedules (name, queue, cron, data) VALUES ($1, $2, $3, $4)
             ON CONFLICT (name) DO UPDATE SET queue = EXCLUDED.queue, cron = EXCLUDED.cron, data = EXCLUDED.data, updated_at = NOW()",
        )
        .bind(name)
        .bind(queue)
        .bind(cron)
        .bind(&data)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn unschedule(&self, name: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM job_schedules WHERE name = $1").bind(name).execute(&self.pool).await?;
        Ok(())
    }
}
