-- Add custom drive settings to users table
-- Each user can enable/disable custom drive and set their own path
-- IMPORTANT: One path can only be owned by one user (enforced by unique constraint)
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_drive_enabled BOOLEAN DEFAULT FALSE NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_drive_path TEXT;

-- Add index for efficient querying of users with custom drive enabled
CREATE INDEX IF NOT EXISTS idx_users_custom_drive_enabled ON users(custom_drive_enabled) WHERE custom_drive_enabled = TRUE;

-- Add unique constraint to ensure one path = one owner
-- This prevents multiple users from using the same custom drive path
-- Only enforce uniqueness when custom_drive_enabled is TRUE and path is NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_custom_drive_path_unique 
ON users(LOWER(custom_drive_path)) 
WHERE custom_drive_enabled = TRUE AND custom_drive_path IS NOT NULL;

