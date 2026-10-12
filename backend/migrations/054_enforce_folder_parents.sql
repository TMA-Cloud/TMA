-- Uploads and folder creation accepted any existing row as the parent, so a
-- right-click paste onto a file stored the pasted items under that file, where
-- no client can list them. Each such row moves up to its nearest folder of the
-- same account (the root when there is none). A clash with a live item of the
-- same type takes a " (n)" suffix, as a move does.
DO $$
DECLARE
  item RECORD;
  target TEXT;
  ext TEXT;
  candidate TEXT;
  counter INTEGER;
BEGIN
  FOR item IN
    SELECT child.id, child.name, child.type, child.user_id, child.parent_id, child.deleted_at
      FROM files child
      JOIN files parent ON parent.id = child.parent_id
     WHERE parent.type <> 'folder' OR parent.user_id IS DISTINCT FROM child.user_id
     ORDER BY child.created_at, child.id
  LOOP
    WITH RECURSIVE up(id, parent_id, type, user_id, depth, visited) AS (
      SELECT f.id, f.parent_id, f.type, f.user_id, 1, ARRAY[item.id, f.id]
        FROM files f
       WHERE f.id = item.parent_id
      UNION ALL
      SELECT f.id, f.parent_id, f.type, f.user_id, up.depth + 1, up.visited || f.id
        FROM up
        JOIN files f ON f.id = up.parent_id
       WHERE NOT (up.type = 'folder' AND up.user_id = item.user_id)
         AND NOT f.id = ANY(up.visited)
    )
    SELECT up.id INTO target
      FROM up
     WHERE up.type = 'folder' AND up.user_id = item.user_id
     ORDER BY up.depth
     LIMIT 1;

    candidate := item.name;
    IF item.deleted_at IS NULL THEN
      -- Same split as path.extname: a leading dot is part of the name.
      ext := CASE WHEN item.type = 'file' THEN COALESCE(substring(item.name FROM '^.+?(\.[^.]*)$'), '') ELSE '' END;
      counter := 0;
      WHILE EXISTS (
        SELECT 1 FROM files sibling
         WHERE sibling.user_id = item.user_id
           AND sibling.parent_id IS NOT DISTINCT FROM target
           AND sibling.type = item.type
           AND sibling.deleted_at IS NULL
           AND sibling.id <> item.id
           AND LOWER(sibling.name) = LOWER(candidate)
      ) LOOP
        counter := counter + 1;
        candidate := left(item.name, length(item.name) - length(ext)) || ' (' || counter || ')' || ext;
      END LOOP;
    END IF;

    UPDATE files SET parent_id = target, name = candidate WHERE id = item.id;
  END LOOP;
END;
$$;

-- AFTER, not BEFORE: a copy inserts folders and their children in one
-- statement, and only AFTER row triggers are guaranteed to see every row it wrote.
CREATE OR REPLACE FUNCTION files_reject_invalid_parent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM files parent
     WHERE parent.id = NEW.parent_id
       AND parent.type = 'folder'
       AND parent.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Parent % of % is not a folder in the same account', NEW.parent_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- The mirror case: a folder must not turn into a file or change account under its children.
CREATE OR REPLACE FUNCTION files_reject_stranding_children()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM files child
     WHERE child.parent_id = NEW.id
       AND (NEW.type <> 'folder' OR child.user_id IS DISTINCT FROM NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'Cannot change % while it still has children', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- WHEN clauses keep renames, stars and access-time flushes from calling either function.
DROP TRIGGER IF EXISTS files_parent_insert ON files;
CREATE TRIGGER files_parent_insert
AFTER INSERT ON files
FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL)
EXECUTE FUNCTION files_reject_invalid_parent();

DROP TRIGGER IF EXISTS files_parent_update ON files;
CREATE TRIGGER files_parent_update
AFTER UPDATE OF parent_id, user_id ON files
FOR EACH ROW WHEN (
  NEW.parent_id IS NOT NULL
  AND (OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.user_id IS DISTINCT FROM NEW.user_id)
)
EXECUTE FUNCTION files_reject_invalid_parent();

DROP TRIGGER IF EXISTS files_children_update ON files;
CREATE TRIGGER files_children_update
AFTER UPDATE OF type, user_id ON files
FOR EACH ROW WHEN (OLD.type IS DISTINCT FROM NEW.type OR OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION files_reject_stranding_children();

-- Every read path assumes these; neither was enforced.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_type_valid;
ALTER TABLE files ADD CONSTRAINT files_type_valid CHECK (type IN ('file', 'folder'));
ALTER TABLE files ALTER COLUMN user_id SET NOT NULL;

-- Left behind when 003 made files.id TEXT; no default has used it since.
DROP SEQUENCE IF EXISTS files_id_seq;

-- The last naive timestamps. The cast reads stored values in the server's
-- default time zone, the one NOW() used when it wrote them.
ALTER TABLE users ALTER COLUMN last_token_invalidation TYPE TIMESTAMPTZ;
ALTER TABLE mfa_backup_codes
  ALTER COLUMN created_at TYPE TIMESTAMPTZ,
  ALTER COLUMN used_at TYPE TIMESTAMPTZ;
