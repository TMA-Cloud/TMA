-- Performance indexes for trash listing
-- The trash UI lists rows where `deleted_at IS NOT NULL`.
-- We already have indexes for `deleted_at IS NULL`; add the missing
-- partial index for deleted rows to avoid sequential scans as the table grows.

CREATE INDEX IF NOT EXISTS idx_files_user_deleted_not_null
ON files (user_id, deleted_at DESC)
WHERE deleted_at IS NOT NULL;

