-- Performance indexes for recursive folder/tree queries
-- Used by recursive CTEs that repeatedly join on `parent_id` and filter by `deleted_at IS NULL`.

-- Helps locate files for a single folder chain step (parent_id + user_id), while ignoring soft-deleted rows.
CREATE INDEX IF NOT EXISTS idx_files_parent_id_user_deleted_null
ON files (parent_id, user_id)
WHERE deleted_at IS NULL;

-- Redundant with the PK on `id`, but included per recommendation to keep lookups fast when both `id` and `user_id` are filtered.
-- Kept partial to reduce index size.
CREATE INDEX IF NOT EXISTS idx_files_id_user_deleted_null
ON files (id, user_id)
WHERE deleted_at IS NULL;

