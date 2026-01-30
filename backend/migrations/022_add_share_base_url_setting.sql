-- Add share base URL setting to app_settings table
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS share_base_url TEXT;
