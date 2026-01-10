-- Add custom drive ignore patterns column
-- Stores JSON array of ignore patterns (strings/regex patterns) for custom drive scanner
-- Defaults to empty array (no ignoring by default)
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_drive_ignore_patterns JSON DEFAULT '[]'::jsonb;
