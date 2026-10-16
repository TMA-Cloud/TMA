-- The first user sets the Cloud Drive access mode for every desktop app;
-- it used to be a per-device switch any user could turn off.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS cloud_drive_save_only BOOLEAN NOT NULL DEFAULT TRUE;
