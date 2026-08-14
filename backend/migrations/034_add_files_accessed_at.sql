-- Last-access time ("accessed at") for files and folders.
--
-- The naive reading of this feature — stamp the row every time someone reads
-- the item — is what no shipping filesystem actually does, because a read then
-- costs a write and the metadata churn outweighs what the value is worth. Both
-- long-standing implementations coalesce instead:
--
--   NTFS guarantees the timestamp only to within one hour, and has shipped
--   with the update switched off by default since Vista.
--
--   Linux mounts with `relatime`: the timestamp is rewritten only when the old
--   value predates the last write, or is more than 24 hours stale.
--
-- We take the NTFS window (one hour, configurable) and Linux's deferred-write
-- idea; both live in services/accessTracker.js, which is the only writer.
ALTER TABLE files ADD COLUMN IF NOT EXISTS accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Existing rows should read the way a freshly copied file reads on Windows:
-- writing an item counts as accessing it, so seed from the write time rather
-- than leaving every row stamped with the migration's clock.
--
-- `modified` alone cannot be trusted for this: uploads and copies preserve the
-- client's mtime, which may sit years in the past or (with a skewed clock) in
-- the future. Clamp it between the row's real creation time and now.
UPDATE files
SET accessed_at = LEAST(GREATEST(created_at, modified), NOW())
WHERE accessed_at >= NOW() - INTERVAL '1 minute';

-- Supports "sort by last opened" and any future "recently opened" listing.
-- Deleted rows are never accessed, so they stay out of the index.
CREATE INDEX IF NOT EXISTS idx_files_user_accessed_at
ON files (user_id, accessed_at DESC)
WHERE deleted_at IS NULL;
