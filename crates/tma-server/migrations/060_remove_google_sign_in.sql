-- Google sign-in is gone: drop each account's Google link and the OAuth client
-- settings, including the sealed client secret.
ALTER TABLE users DROP COLUMN IF EXISTS google_id;

ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_google_complete;
ALTER TABLE app_settings
    DROP COLUMN IF EXISTS google_client_id,
    DROP COLUMN IF EXISTS google_client_secret_encrypted,
    DROP COLUMN IF EXISTS google_client_secret_kek_version,
    DROP COLUMN IF EXISTS google_redirect_uri,
    DROP COLUMN IF EXISTS google_updated_at,
    DROP COLUMN IF EXISTS google_config_version;
