-- Exact folder metrics are maintained on writes so listing by size never has
-- to walk every descendant merely to return one page.
ALTER TABLE files ADD COLUMN IF NOT EXISTS aggregate_size BIGINT NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN IF NOT EXISTS aggregate_file_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN IF NOT EXISTS aggregate_folder_count INTEGER NOT NULL DEFAULT 0;

WITH RECURSIVE descendants(root_id, id, type, size, visited) AS (
  SELECT f.id, f.id, f.type, f.size, ARRAY[f.id]
    FROM files f
   WHERE f.type = 'folder'
  UNION ALL
  SELECT d.root_id, child.id, child.type, child.size, d.visited || child.id
    FROM descendants d
    JOIN files child ON child.parent_id = d.id
   WHERE NOT child.id = ANY(d.visited)
), totals AS (
  SELECT root_id,
         COALESCE(SUM(size) FILTER (WHERE type = 'file'), 0)::bigint AS bytes,
         COUNT(*) FILTER (WHERE type = 'file')::integer AS files,
         GREATEST(COUNT(*) FILTER (WHERE type = 'folder') - 1, 0)::integer AS folders
    FROM descendants
   GROUP BY root_id
)
UPDATE files f
   SET aggregate_size = totals.bytes,
       aggregate_file_count = totals.files,
       aggregate_folder_count = totals.folders
  FROM totals
 WHERE f.id = totals.root_id;

CREATE OR REPLACE FUNCTION adjust_file_ancestor_aggregates(
  start_parent TEXT,
  byte_delta BIGINT,
  file_delta INTEGER,
  folder_delta INTEGER
) RETURNS VOID AS $$
BEGIN
  IF start_parent IS NULL OR (byte_delta = 0 AND file_delta = 0 AND folder_delta = 0) THEN
    RETURN;
  END IF;

  WITH RECURSIVE ancestors(id, visited) AS (
    SELECT start_parent, ARRAY[start_parent]
    UNION ALL
    SELECT parent.parent_id, ancestors.visited || parent.parent_id
      FROM ancestors
      JOIN files parent ON parent.id = ancestors.id
     WHERE parent.parent_id IS NOT NULL
       AND NOT parent.parent_id = ANY(ancestors.visited)
  )
  UPDATE files folder
     SET aggregate_size = GREATEST(0, folder.aggregate_size + byte_delta),
         aggregate_file_count = GREATEST(0, folder.aggregate_file_count + file_delta),
         aggregate_folder_count = GREATEST(0, folder.aggregate_folder_count + folder_delta)
   WHERE folder.id IN (SELECT id FROM ancestors)
     AND folder.type = 'folder';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION maintain_file_ancestor_aggregates() RETURNS TRIGGER AS $$
DECLARE
  old_bytes BIGINT := 0;
  old_files INTEGER := 0;
  old_folders INTEGER := 0;
  new_bytes BIGINT := 0;
  new_files INTEGER := 0;
  new_folders INTEGER := 0;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    IF OLD.type = 'file' THEN
      old_bytes := COALESCE(OLD.size, 0);
      old_files := 1;
    ELSE
      old_bytes := COALESCE(OLD.aggregate_size, 0);
      old_files := COALESCE(OLD.aggregate_file_count, 0);
      old_folders := COALESCE(OLD.aggregate_folder_count, 0) + 1;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.type = 'file' THEN
      new_bytes := COALESCE(NEW.size, 0);
      new_files := 1;
    ELSE
      new_bytes := COALESCE(NEW.aggregate_size, 0);
      new_files := COALESCE(NEW.aggregate_file_count, 0);
      new_folders := COALESCE(NEW.aggregate_folder_count, 0) + 1;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM adjust_file_ancestor_aggregates(NEW.parent_id, new_bytes, new_files, new_folders);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM adjust_file_ancestor_aggregates(OLD.parent_id, -old_bytes, -old_files, -old_folders);
    RETURN OLD;
  END IF;

  IF OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.type IS DISTINCT FROM NEW.type THEN
    PERFORM adjust_file_ancestor_aggregates(OLD.parent_id, -old_bytes, -old_files, -old_folders);
    PERFORM adjust_file_ancestor_aggregates(NEW.parent_id, new_bytes, new_files, new_folders);
  ELSE
    PERFORM adjust_file_ancestor_aggregates(
      NEW.parent_id,
      new_bytes - old_bytes,
      new_files - old_files,
      new_folders - old_folders
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS files_aggregate_insert ON files;
DROP TRIGGER IF EXISTS files_aggregate_delete ON files;
DROP TRIGGER IF EXISTS files_aggregate_update ON files;

CREATE TRIGGER files_aggregate_insert
AFTER INSERT ON files
FOR EACH ROW EXECUTE FUNCTION maintain_file_ancestor_aggregates();

CREATE TRIGGER files_aggregate_delete
AFTER DELETE ON files
FOR EACH ROW EXECUTE FUNCTION maintain_file_ancestor_aggregates();

CREATE TRIGGER files_aggregate_update
AFTER UPDATE OF parent_id, size, type ON files
FOR EACH ROW EXECUTE FUNCTION maintain_file_ancestor_aggregates();

-- These indexes match the stable folder-first keyset orders used by the most
-- common authenticated listing sorts and the public shared-folder listing.
CREATE INDEX IF NOT EXISTS idx_files_active_parent_name_page
ON files (user_id, parent_id, type DESC, name, id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_active_parent_modified_page
ON files (user_id, parent_id, type DESC, modified, id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_active_parent_accessed_page
ON files (user_id, parent_id, type DESC, accessed_at, id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_active_parent_size_page
ON files (user_id, parent_id, type DESC, (CASE WHEN type = 'folder' THEN aggregate_size ELSE size END), id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_public_parent_name_page
ON files (parent_id, (CASE WHEN type = 'folder' THEN 0 ELSE 1 END), lower(name), id)
WHERE deleted_at IS NULL;
