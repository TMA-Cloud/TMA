-- Add max upload size setting to app_settings (single file limit in bytes).
-- Default 10GB = 10 * 1024 * 1024 * 1024
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS max_upload_size_bytes BIGINT DEFAULT 10737418240;
