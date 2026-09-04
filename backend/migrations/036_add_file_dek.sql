-- Envelope encryption: per-file wrapped data keys (DEKs).
--
-- Each file body is encrypted under its own random DEK; the DEK is wrapped by
-- the master key-encryption-key (KEK) and stored here. Rotating the master key
-- then only rewraps these ~60-byte values — an UPDATE per row — instead of
-- re-encrypting (and, on S3/R2, re-uploading) every object. See
-- utils/fileEncryption/keyWrap.js.
--
-- Both columns are nullable and default NULL. A NULL dek_wrapped marks a
-- pre-envelope file whose body is keyed directly off the master key; the read
-- path falls back to the master key for those, so existing rows keep working
-- untouched until a one-off backfill re-encrypts them under a DEK.
ALTER TABLE files ADD COLUMN IF NOT EXISTS dek_wrapped BYTEA;
ALTER TABLE files ADD COLUMN IF NOT EXISTS dek_kek_version INTEGER;

-- Lets the rotation job find the files still wrapped under an old KEK version
-- (or not yet enveloped) without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_files_dek_kek_version
ON files (dek_kek_version)
WHERE type = 'file' AND deleted_at IS NULL AND path IS NOT NULL;
