-- Add agent settings to app_settings table
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS agent_url TEXT,
ADD COLUMN IF NOT EXISTS agent_token TEXT;
