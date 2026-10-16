-- Add last_backup_code_regeneration timestamp to track cooldown for backup code regeneration
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_backup_code_regeneration TIMESTAMPTZ;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_last_backup_code_regeneration ON users(id, last_backup_code_regeneration) WHERE last_backup_code_regeneration IS NOT NULL;
