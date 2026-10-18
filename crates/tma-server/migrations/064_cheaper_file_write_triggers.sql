-- Cheaper writes to files.
--
-- Storage usage only changes with a file's size, type or owner, but its
-- statement trigger ran on every UPDATE (stars, shares, access times, the
-- folder aggregate updates below), capturing old and new rows each time.
-- Transition tables cannot be limited to columns, so it becomes a row trigger
-- that fires only on those changes.
DROP TRIGGER IF EXISTS files_storage_update ON files;
DROP FUNCTION IF EXISTS apply_file_storage_update();

CREATE OR REPLACE FUNCTION apply_file_storage_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_account TEXT;
  new_account TEXT;
  old_bytes BIGINT := CASE WHEN OLD.type = 'file' THEN COALESCE(OLD.size, 0) ELSE 0 END;
  new_bytes BIGINT := CASE WHEN NEW.type = 'file' THEN COALESCE(NEW.size, 0) ELSE 0 END;
BEGIN
  SELECT COALESCE(parent_user_id, id) INTO old_account FROM users WHERE id = OLD.user_id;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    SELECT COALESCE(parent_user_id, id) INTO new_account FROM users WHERE id = NEW.user_id;
  ELSE
    new_account := old_account;
  END IF;
  IF old_account IS NOT DISTINCT FROM new_account THEN
    IF new_bytes <> old_bytes THEN
      UPDATE users SET storage_used = GREATEST(0, storage_used + new_bytes - old_bytes) WHERE id = new_account;
    END IF;
  ELSE
    UPDATE users SET storage_used = GREATEST(0, storage_used - old_bytes) WHERE id = old_account;
    UPDATE users SET storage_used = storage_used + new_bytes WHERE id = new_account;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER files_storage_update
AFTER UPDATE OF size, type, user_id ON files
FOR EACH ROW
WHEN (OLD.size IS DISTINCT FROM NEW.size OR OLD.type IS DISTINCT FROM NEW.type OR OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION apply_file_storage_change();

-- Folder aggregates walked every ancestor once per inserted or deleted row, so
-- an upload batch, a copy or a permanent delete of N items under one folder
-- updated that folder (and each above it) N times. A statement now groups its
-- rows by parent and walks each ancestor chain once. Moves stay row by row.
-- Each row contributes what the row trigger added: a file its size and one
-- file, a folder its own totals plus itself.
CREATE OR REPLACE FUNCTION apply_file_aggregates(rows_sign INTEGER, contribution JSONB) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  WITH RECURSIVE start AS (
    SELECT c.parent_id AS id,
           rows_sign * c.bytes AS bytes, rows_sign * c.files AS files, rows_sign * c.folders AS folders
      FROM jsonb_to_recordset(contribution) AS c(parent_id TEXT, bytes BIGINT, files INTEGER, folders INTEGER)
  ), ancestors(id, bytes, files, folders, visited) AS (
    SELECT id, bytes, files, folders, ARRAY[id] FROM start
    UNION ALL
    SELECT parent.parent_id, a.bytes, a.files, a.folders, a.visited || parent.parent_id
      FROM ancestors a
      JOIN files parent ON parent.id = a.id
     WHERE parent.parent_id IS NOT NULL
       AND NOT parent.parent_id = ANY(a.visited)
  )
  UPDATE files folder
     SET aggregate_size = GREATEST(0, folder.aggregate_size + delta.bytes),
         aggregate_file_count = GREATEST(0, folder.aggregate_file_count + delta.files),
         aggregate_folder_count = GREATEST(0, folder.aggregate_folder_count + delta.folders)
    FROM (
      SELECT id, SUM(bytes)::BIGINT AS bytes, SUM(files)::INTEGER AS files, SUM(folders)::INTEGER AS folders
        FROM ancestors GROUP BY id
    ) delta
   WHERE folder.id = delta.id
     AND folder.type = 'folder'
     AND (delta.bytes <> 0 OR delta.files <> 0 OR delta.folders <> 0);
END;
$$;

CREATE OR REPLACE FUNCTION apply_file_aggregates_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM apply_file_aggregates(1, (
    SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM (
      SELECT parent_id,
             SUM(CASE WHEN type = 'file' THEN COALESCE(size, 0) ELSE aggregate_size END) AS bytes,
             SUM(CASE WHEN type = 'file' THEN 1 ELSE aggregate_file_count END) AS files,
             SUM(CASE WHEN type = 'file' THEN 0 ELSE aggregate_folder_count + 1 END) AS folders
        FROM new_file_rows WHERE parent_id IS NOT NULL GROUP BY parent_id
    ) c
  ));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION apply_file_aggregates_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM apply_file_aggregates(-1, (
    SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM (
      SELECT parent_id,
             SUM(CASE WHEN type = 'file' THEN COALESCE(size, 0) ELSE aggregate_size END) AS bytes,
             SUM(CASE WHEN type = 'file' THEN 1 ELSE aggregate_file_count END) AS files,
             SUM(CASE WHEN type = 'file' THEN 0 ELSE aggregate_folder_count + 1 END) AS folders
        FROM old_file_rows WHERE parent_id IS NOT NULL GROUP BY parent_id
    ) c
  ));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS files_aggregate_insert ON files;
DROP TRIGGER IF EXISTS files_aggregate_delete ON files;
CREATE TRIGGER files_aggregate_insert
AFTER INSERT ON files REFERENCING NEW TABLE AS new_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION apply_file_aggregates_insert();
CREATE TRIGGER files_aggregate_delete
AFTER DELETE ON files REFERENCING OLD TABLE AS old_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION apply_file_aggregates_delete();

-- Indexes another index already serves, each one more write per change:
-- path lookups use the unique (path, user_id, type) index with the same predicate;
-- trash queries use the partial deleted_at indexes; users are found by primary key;
-- sessions by (user_id, token_version). A heartbeat table holds one row per install,
-- and indexing last_seen_at kept every heartbeat from being a HOT update.
DROP INDEX IF EXISTS idx_files_path;
DROP INDEX IF EXISTS idx_files_deleted_at;
DROP INDEX IF EXISTS idx_users_token_version;
DROP INDEX IF EXISTS idx_users_storage_limit;
DROP INDEX IF EXISTS idx_users_last_backup_code_regeneration;
DROP INDEX IF EXISTS idx_users_mfa_enabled;
DROP INDEX IF EXISTS idx_sessions_user_id;
DROP INDEX IF EXISTS idx_client_heartbeats_last_seen;
