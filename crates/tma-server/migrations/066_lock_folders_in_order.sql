-- Writes take their row locks in one order: account, then folders by id.
--
-- Every write updates the totals of the folders above it. Each statement
-- locked those folders in whatever order its walk or join produced, so two
-- writes whose paths shared folders (an upload and a copy, say) could lock
-- them in opposite orders and deadlock under load. Both functions now lock
-- the folders they will update by id first, then update them; the arithmetic
-- is unchanged.
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
  ), delta AS (
    SELECT id, SUM(bytes)::BIGINT AS bytes, SUM(files)::INTEGER AS files, SUM(folders)::INTEGER AS folders
      FROM ancestors GROUP BY id
  ), locked AS MATERIALIZED (
    SELECT folder.id FROM files folder JOIN delta ON delta.id = folder.id
     WHERE folder.type = 'folder' AND (delta.bytes <> 0 OR delta.files <> 0 OR delta.folders <> 0)
     ORDER BY folder.id FOR NO KEY UPDATE OF folder
  )
  UPDATE files folder
     SET aggregate_size = GREATEST(0, folder.aggregate_size + delta.bytes),
         aggregate_file_count = GREATEST(0, folder.aggregate_file_count + delta.files),
         aggregate_folder_count = GREATEST(0, folder.aggregate_folder_count + delta.folders)
    FROM delta
   WHERE folder.id = delta.id
     AND folder.id IN (SELECT id FROM locked);
END;
$$;

CREATE OR REPLACE FUNCTION adjust_file_ancestor_aggregates(
  start_parent TEXT, byte_delta BIGINT, file_delta INTEGER, folder_delta INTEGER
) RETURNS void
LANGUAGE plpgsql AS $$
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
  ), locked AS MATERIALIZED (
    SELECT folder.id FROM files folder
     WHERE folder.id IN (SELECT id FROM ancestors) AND folder.type = 'folder'
     ORDER BY folder.id FOR NO KEY UPDATE OF folder
  )
  UPDATE files folder
     SET aggregate_size = GREATEST(0, folder.aggregate_size + byte_delta),
         aggregate_file_count = GREATEST(0, folder.aggregate_file_count + file_delta),
         aggregate_folder_count = GREATEST(0, folder.aggregate_folder_count + folder_delta)
   WHERE folder.id IN (SELECT id FROM locked);
END;
$$;

-- Accounts before folders. A write changes its account's storage use as well
-- as folder totals; quota checks lock the account first, but triggers locked
-- folders and then the account (a copy, emptying the trash), the other way
-- round. These fire before the totals and storage triggers (triggers run in
-- name order), so every write locks its account, then folders by id.
CREATE OR REPLACE FUNCTION lock_accounts_of_new_rows() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id IN (SELECT DISTINCT user_id FROM new_rows) ORDER BY id FOR NO KEY UPDATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION lock_accounts_of_old_rows() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id IN (SELECT DISTINCT user_id FROM old_rows) ORDER BY id FOR NO KEY UPDATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION lock_account_of_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id IN (OLD.user_id, NEW.user_id) ORDER BY id FOR NO KEY UPDATE;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS files_a_lock_accounts_insert ON files;
CREATE TRIGGER files_a_lock_accounts_insert AFTER INSERT ON files
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lock_accounts_of_new_rows();

DROP TRIGGER IF EXISTS files_a_lock_accounts_delete ON files;
CREATE TRIGGER files_a_lock_accounts_delete AFTER DELETE ON files
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lock_accounts_of_old_rows();

DROP TRIGGER IF EXISTS files_a_lock_account_update ON files;
CREATE TRIGGER files_a_lock_account_update AFTER UPDATE OF parent_id, size, type, user_id ON files
FOR EACH ROW
WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.size IS DISTINCT FROM NEW.size
   OR OLD.type IS DISTINCT FROM NEW.type OR OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION lock_account_of_row();
