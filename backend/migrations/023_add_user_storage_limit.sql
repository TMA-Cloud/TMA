-- Migration: Add storage_limit column to users table
-- Allows per-user storage limits (NULL means use actual available disk space)
-- Storage limits are managed per-user in the admin settings

ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_limit BIGINT;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_storage_limit ON users(id, storage_limit);
