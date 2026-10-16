-- The background job queue, kept in Postgres so a job is durable the moment
-- its request commits. It replaces pg-boss: workers claim rows with
-- FOR UPDATE SKIP LOCKED, and a singleton key both de-duplicates scheduled
-- jobs and keeps one account's file operations in strict FIFO order.
CREATE TABLE IF NOT EXISTS job_queue (
  id UUID PRIMARY KEY,
  queue TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'created'
    CHECK (state IN ('created', 'active', 'completed', 'failed', 'cancelled')),
  singleton_key TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_limit INTEGER NOT NULL DEFAULT 3,
  retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
  retry_backoff BOOLEAN NOT NULL DEFAULT TRUE,
  retry_delay_max_seconds INTEGER NOT NULL DEFAULT 3600,
  expire_seconds INTEGER NOT NULL DEFAULT 3600,
  start_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  keep_seconds INTEGER NOT NULL DEFAULT 86400,
  output JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The claim query walks ready rows of one queue oldest first.
CREATE INDEX IF NOT EXISTS idx_job_queue_ready
  ON job_queue (queue, created_at)
  WHERE state = 'created';

-- "Is this key busy?" and "is there an older job for this key?" checks.
CREATE INDEX IF NOT EXISTS idx_job_queue_key
  ON job_queue (queue, singleton_key, state)
  WHERE singleton_key IS NOT NULL AND state IN ('created', 'active');

-- Expired active jobs (a worker died mid-job) are found by start time.
CREATE INDEX IF NOT EXISTS idx_job_queue_active
  ON job_queue (started_at)
  WHERE state = 'active';

-- Finished rows are purged once their retention has passed.
CREATE INDEX IF NOT EXISTS idx_job_queue_finished
  ON job_queue (completed_at)
  WHERE state IN ('completed', 'failed', 'cancelled');

-- Cron schedules. A row per name; the worker enqueues one job per due minute.
CREATE TABLE IF NOT EXISTS job_schedules (
  name TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  cron TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
