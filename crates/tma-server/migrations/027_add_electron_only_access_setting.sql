-- Add electron-only access setting to app_settings (admin/first user only).
-- When true, only requests from the desktop app (Electron) with the configured header are allowed.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS require_electron_client BOOLEAN DEFAULT false;

