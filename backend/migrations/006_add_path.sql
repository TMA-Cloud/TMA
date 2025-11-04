ALTER TABLE files ADD COLUMN IF NOT EXISTS path TEXT;

-- Add unique constraint to prevent duplicate files with same path/user_id/type
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path_user_type_unique
ON files (path, user_id, type)
WHERE path IS NOT NULL;

-- Add index for faster path lookups
CREATE INDEX IF NOT EXISTS idx_files_path
ON files (path)
WHERE path IS NOT NULL;
