-- Row creation time for the files table.
--
-- `modified` cannot be used to tell how old a row is: uploads and copies
-- preserve the client's original mtime, so a file added seconds ago can carry
-- a timestamp from years back. Orphan detection needs a trustworthy "when was
-- this row written" value so that an in-flight upload/paste/move is never
-- mistaken for an orphan.
ALTER TABLE files ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Rows that already existed when this migration ran are, by definition, not
-- in flight. Backfill them with a timestamp that is safely in the past while
-- keeping a meaningful value where `modified` is older than now.
UPDATE files
SET created_at = LEAST(COALESCE(modified, NOW()), NOW() - INTERVAL '1 hour')
WHERE created_at >= NOW() - INTERVAL '1 minute';

CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
