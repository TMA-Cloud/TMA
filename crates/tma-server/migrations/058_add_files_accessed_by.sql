-- Who last opened a file: the signed-in identity, so a sub-user's opens are
-- told apart from the owner's. NULL for share-link visitors and older opens.
ALTER TABLE files ADD COLUMN IF NOT EXISTS accessed_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Deleting a user clears these without scanning every file.
CREATE INDEX IF NOT EXISTS idx_files_accessed_by ON files (accessed_by) WHERE accessed_by IS NOT NULL;
