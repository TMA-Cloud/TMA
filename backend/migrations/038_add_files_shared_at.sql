-- Item-level timestamp for the moment a file or folder became shared.
--
-- share_links.created_at only covers share roots. Descendants and files added
-- to an already-shared folder also carry files.shared = TRUE, so the timestamp
-- belongs on the file row alongside that flag.
ALTER TABLE files ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;

-- Preserve the original link creation time where possible for existing data.
-- The fallback covers legacy shared rows whose membership/link was already
-- removed or otherwise cannot be reconstructed.
UPDATE files f
SET shared_at = COALESCE(
  (
    SELECT MIN(sl.created_at)
    FROM share_link_files slf
    JOIN share_links sl ON sl.id = slf.share_id
    WHERE slf.file_id = f.id
      AND sl.user_id = f.user_id
  ),
  NOW()
)
WHERE f.shared = TRUE
  AND f.shared_at IS NULL;
