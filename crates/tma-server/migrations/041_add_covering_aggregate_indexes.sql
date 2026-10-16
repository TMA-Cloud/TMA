-- Replace an index that stored a predicate-fixed deleted_at column with a
-- covering form used by dashboard statistics.
DROP INDEX IF EXISTS idx_files_user_deleted_prefix;
CREATE INDEX IF NOT EXISTS idx_files_user_active_stats
ON files (user_id)
INCLUDE (type, starred, shared, parent_id)
WHERE deleted_at IS NULL;

-- Quota checks sum this column before uploads. Including size allows an
-- index-only aggregate while retaining trashed files, which still use storage.
CREATE INDEX IF NOT EXISTS idx_files_user_storage_usage
ON files (user_id)
INCLUDE (size)
WHERE type = 'file';
