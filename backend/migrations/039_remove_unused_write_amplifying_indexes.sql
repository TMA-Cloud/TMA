-- These indexes are not used by application queries and add work to every
-- corresponding INSERT/UPDATE. They can be recreated later if external
-- reporting demonstrates a real workload for them.
DROP INDEX IF EXISTS idx_files_id_user_deleted_null;
DROP INDEX IF EXISTS idx_files_name_gin;
DROP INDEX IF EXISTS idx_audit_log_metadata;

-- Supports bounded oldest-first trash cleanup without scanning all deleted rows.
CREATE INDEX IF NOT EXISTS idx_files_trash_cleanup
ON files (deleted_at, id)
WHERE deleted_at IS NOT NULL;
