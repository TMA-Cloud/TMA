-- Idempotency ledger for durable file jobs. A worker retry can observe that a
-- copy committed and return the original IDs instead of creating duplicates.
CREATE TABLE IF NOT EXISTS file_operation_results (
  job_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  task text NOT NULL,
  output jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_operation_results_completed
  ON file_operation_results (completed_at);
