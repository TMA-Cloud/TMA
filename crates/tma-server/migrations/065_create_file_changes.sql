-- A change feed of folders whose listing changed, so a desktop app re-lists
-- only those instead of every folder it has open (GET /api/files/changes).
--
-- Rows carry the id of the transaction that wrote them. A client's cursor is
-- the oldest transaction still running when it last asked: everything older
-- has committed or rolled back, so a slow transaction can never land behind a
-- cursor that already passed it, as a plain sequence number could.
CREATE TABLE IF NOT EXISTS file_changes (
    owner_id   TEXT NOT NULL,
    -- The folder whose listing changed; NULL is the account's root.
    folder_id  TEXT,
    xid        XID8 NOT NULL DEFAULT pg_current_xact_id(),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_changes_owner_xid ON file_changes (owner_id, xid);
CREATE INDEX IF NOT EXISTS idx_file_changes_changed_at ON file_changes (changed_at);

-- Pruning keeps a week; a cursor at or below the newest pruned transaction may
-- have missed rows, so its client starts over with a full resync.
CREATE TABLE IF NOT EXISTS file_change_floor (
    id  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    xid XID8 NOT NULL
);
INSERT INTO file_change_floor (id, xid) VALUES (TRUE, '0') ON CONFLICT DO NOTHING;

-- Inserts and deletes come in bulk (uploads, emptying the trash): one row per
-- folder per statement.
CREATE OR REPLACE FUNCTION record_file_inserts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO file_changes (owner_id, folder_id) SELECT DISTINCT user_id, parent_id FROM new_rows;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION record_file_deletes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO file_changes (owner_id, folder_id) SELECT DISTINCT user_id, parent_id FROM old_rows;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS files_changes_insert ON files;
CREATE TRIGGER files_changes_insert AFTER INSERT ON files
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION record_file_inserts();

DROP TRIGGER IF EXISTS files_changes_delete ON files;
CREATE TRIGGER files_changes_delete AFTER DELETE ON files
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION record_file_deletes();

-- Updates fire only for what a listing shows, so folder totals and access
-- times (updated constantly) write nothing here. A move changes both folders.
CREATE OR REPLACE FUNCTION record_file_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO file_changes (owner_id, folder_id) VALUES (NEW.user_id, NEW.parent_id);
  IF OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    INSERT INTO file_changes (owner_id, folder_id) VALUES (OLD.user_id, OLD.parent_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS files_changes_update ON files;
CREATE TRIGGER files_changes_update
AFTER UPDATE OF name, parent_id, deleted_at, type, size, modified, content_version, mime_type, user_id ON files
FOR EACH ROW
WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
   OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.type IS DISTINCT FROM NEW.type
   OR OLD.size IS DISTINCT FROM NEW.size OR OLD.modified IS DISTINCT FROM NEW.modified
   OR OLD.content_version IS DISTINCT FROM NEW.content_version
   OR OLD.mime_type IS DISTINCT FROM NEW.mime_type OR OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION record_file_update();

-- Who is editing shows in listings too. Renewing a lease only moves its
-- expiry, which nobody sees, so it records nothing.
CREATE OR REPLACE FUNCTION record_lock_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  locked TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.file_id ELSE NEW.file_id END;
BEGIN
  INSERT INTO file_changes (owner_id, folder_id) SELECT f.user_id, f.parent_id FROM files f WHERE f.id = locked;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS file_locks_changes ON file_locks;
CREATE TRIGGER file_locks_changes AFTER INSERT OR DELETE ON file_locks
FOR EACH ROW EXECUTE FUNCTION record_lock_change();

DROP TRIGGER IF EXISTS file_locks_changes_holder ON file_locks;
CREATE TRIGGER file_locks_changes_holder AFTER UPDATE OF user_id, device_id ON file_locks
FOR EACH ROW
WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.device_id IS DISTINCT FROM NEW.device_id)
EXECUTE FUNCTION record_lock_change();
