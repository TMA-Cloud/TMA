-- Reserve quota before long-running object-store operations without holding a
-- user-row lock for the duration of network I/O.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS storage_reserved BIGINT NOT NULL DEFAULT 0;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_storage_reserved_nonnegative;
ALTER TABLE users
  ADD CONSTRAINT users_storage_reserved_nonnegative CHECK (storage_reserved >= 0);

CREATE TABLE IF NOT EXISTS storage_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  purpose TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_reservations_expires_at
  ON storage_reservations(expires_at, id);

CREATE OR REPLACE FUNCTION apply_storage_reservation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users account
     SET storage_reserved = account.storage_reserved + delta.bytes
    FROM (
      SELECT user_id, SUM(bytes)::BIGINT AS bytes
        FROM new_reservations
       GROUP BY user_id
    ) delta
   WHERE account.id = delta.user_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION apply_storage_reservation_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users account
     SET storage_reserved = GREATEST(0, account.storage_reserved - delta.bytes)
    FROM (
      SELECT user_id, SUM(bytes)::BIGINT AS bytes
        FROM old_reservations
       GROUP BY user_id
    ) delta
   WHERE account.id = delta.user_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS storage_reservation_insert ON storage_reservations;
CREATE TRIGGER storage_reservation_insert
AFTER INSERT ON storage_reservations
REFERENCING NEW TABLE AS new_reservations
FOR EACH STATEMENT EXECUTE FUNCTION apply_storage_reservation_insert();

DROP TRIGGER IF EXISTS storage_reservation_delete ON storage_reservations;
CREATE TRIGGER storage_reservation_delete
AFTER DELETE ON storage_reservations
REFERENCING OLD TABLE AS old_reservations
FOR EACH STATEMENT EXECUTE FUNCTION apply_storage_reservation_delete();

-- Migration 041 supported the former SUM(size) quota read. Runtime quota reads
-- now use users.storage_used and administrative imports use the same counter.
DROP INDEX IF EXISTS idx_files_user_storage_usage;
