-- Add allow_password_change setting to app_settings (admin/first user only).
-- When true, users are allowed to change their own passwords from Settings.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS allow_password_change BOOLEAN DEFAULT false;

