-- Keep account storage usage in one row so quota checks and admin listings are O(1).
-- Files are normally owned by the top-level account; COALESCE also keeps the
-- counter correct if a legacy row is attached directly to a sub-user.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS storage_used BIGINT NOT NULL DEFAULT 0;

UPDATE users u
   SET storage_used = usage.used
  FROM (
    SELECT COALESCE(owner.parent_user_id, f.user_id) AS account_id,
           COALESCE(SUM(f.size), 0)::BIGINT AS used
      FROM files f
      JOIN users owner ON owner.id = f.user_id
     WHERE f.type = 'file'
     GROUP BY COALESCE(owner.parent_user_id, f.user_id)
  ) usage
 WHERE u.id = usage.account_id;

UPDATE users
   SET storage_used = 0
 WHERE parent_user_id IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM files f
       JOIN users owner ON owner.id = f.user_id
      WHERE f.type = 'file'
        AND COALESCE(owner.parent_user_id, f.user_id) = users.id
   );

CREATE OR REPLACE FUNCTION apply_file_storage_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users account
     SET storage_used = account.storage_used + delta.bytes
    FROM (
      SELECT COALESCE(owner.parent_user_id, rows.user_id) AS account_id,
             COALESCE(SUM(rows.size), 0)::BIGINT AS bytes
        FROM new_file_rows rows
        JOIN users owner ON owner.id = rows.user_id
       WHERE rows.type = 'file'
       GROUP BY COALESCE(owner.parent_user_id, rows.user_id)
    ) delta
   WHERE account.id = delta.account_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION apply_file_storage_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users account
     SET storage_used = GREATEST(0, account.storage_used - delta.bytes)
    FROM (
      SELECT COALESCE(owner.parent_user_id, rows.user_id) AS account_id,
             COALESCE(SUM(rows.size), 0)::BIGINT AS bytes
        FROM old_file_rows rows
        JOIN users owner ON owner.id = rows.user_id
       WHERE rows.type = 'file'
       GROUP BY COALESCE(owner.parent_user_id, rows.user_id)
    ) delta
   WHERE account.id = delta.account_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION apply_file_storage_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users account
     SET storage_used = GREATEST(0, account.storage_used + delta.bytes)
    FROM (
      SELECT account_id, SUM(bytes)::BIGINT AS bytes
        FROM (
          SELECT COALESCE(owner.parent_user_id, rows.user_id) AS account_id,
                 -COALESCE(SUM(rows.size), 0)::BIGINT AS bytes
            FROM old_file_rows rows
            JOIN users owner ON owner.id = rows.user_id
           WHERE rows.type = 'file'
           GROUP BY COALESCE(owner.parent_user_id, rows.user_id)
          UNION ALL
          SELECT COALESCE(owner.parent_user_id, rows.user_id) AS account_id,
                 COALESCE(SUM(rows.size), 0)::BIGINT AS bytes
            FROM new_file_rows rows
            JOIN users owner ON owner.id = rows.user_id
           WHERE rows.type = 'file'
           GROUP BY COALESCE(owner.parent_user_id, rows.user_id)
        ) changes
       GROUP BY account_id
    ) delta
   WHERE account.id = delta.account_id
     AND delta.bytes <> 0;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS files_storage_insert ON files;
CREATE TRIGGER files_storage_insert
AFTER INSERT ON files
REFERENCING NEW TABLE AS new_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION apply_file_storage_insert();

DROP TRIGGER IF EXISTS files_storage_delete ON files;
CREATE TRIGGER files_storage_delete
AFTER DELETE ON files
REFERENCING OLD TABLE AS old_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION apply_file_storage_delete();

DROP TRIGGER IF EXISTS files_storage_update ON files;
CREATE TRIGGER files_storage_update
AFTER UPDATE ON files
REFERENCING OLD TABLE AS old_file_rows NEW TABLE AS new_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION apply_file_storage_update();

ALTER TABLE files
  DROP CONSTRAINT IF EXISTS files_parent_not_self;
ALTER TABLE files
  ADD CONSTRAINT files_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id);
