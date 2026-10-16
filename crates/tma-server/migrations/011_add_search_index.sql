-- Enable pg_trgm extension for optimized fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN index on name column for fast trigram similarity searches
-- This index significantly speeds up ILIKE queries and similarity searches
-- Using gin_trgm_ops operator class for optimal trigram performance
CREATE INDEX IF NOT EXISTS idx_files_name_gin ON files USING gin (name gin_trgm_ops);

-- Create GIN index on lower(name) for case-insensitive trigram searches
-- This is more efficient than wrapping lower() in queries
CREATE INDEX IF NOT EXISTS idx_files_name_lower_gin ON files USING gin (lower(name) gin_trgm_ops);

-- Create composite index for optimized prefix searches (user_id + deleted_at)
-- Used for filtering by user before applying name prefix matching
CREATE INDEX IF NOT EXISTS idx_files_user_deleted_prefix ON files(user_id, deleted_at) 
WHERE deleted_at IS NULL;

-- Create B-tree index on lower(name) for prefix matching optimization
-- This is faster than GIN for simple prefix queries
CREATE INDEX IF NOT EXISTS idx_files_name_lower_btree ON files(lower(name) text_pattern_ops);

