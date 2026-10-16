-- Explicit reverse proxies trusted to supply forwarded client information.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS known_proxies TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
