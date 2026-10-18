-- Edit locks name the desktop install holding them, so the same person signed
-- in on a second computer is kept out like anyone else.
ALTER TABLE file_locks ADD COLUMN IF NOT EXISTS device_id TEXT;
