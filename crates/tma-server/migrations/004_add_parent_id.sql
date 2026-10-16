ALTER TABLE files ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES files(id);
CREATE INDEX IF NOT EXISTS idx_files_parent_id ON files(parent_id);
