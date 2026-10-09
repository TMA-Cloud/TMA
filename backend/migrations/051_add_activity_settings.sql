-- Session idle timeout and last-access tracking are set by the first user
-- instead of SESSION_IDLE_DAYS and the ACCESS_TIME_* environment variables.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS session_idle_days INTEGER NOT NULL DEFAULT 30,
ADD COLUMN IF NOT EXISTS access_time_tracking BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS access_time_window_minutes INTEGER NOT NULL DEFAULT 60,
ADD COLUMN IF NOT EXISTS access_time_flush_seconds INTEGER NOT NULL DEFAULT 10;

-- The same ranges as utils/activitySettings.js, so no write path can store a value the app rejects.
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_activity_ranges;
ALTER TABLE app_settings
ADD CONSTRAINT app_settings_activity_ranges CHECK (
    session_idle_days BETWEEN 1 AND 365
    AND access_time_window_minutes BETWEEN 0 AND 1440
    AND access_time_flush_seconds BETWEEN 1 AND 300
);
