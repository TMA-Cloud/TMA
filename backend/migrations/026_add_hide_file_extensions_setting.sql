-- Add hide file extensions setting to app_settings (admin/first user only).
-- When true, file names are shown without extensions in the UI.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS hide_file_extensions BOOLEAN DEFAULT false;
