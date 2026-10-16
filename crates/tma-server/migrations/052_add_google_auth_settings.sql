-- Google sign-in is configured by the first user instead of GOOGLE_* environment
-- variables. The client secret is stored AES-256-GCM encrypted under the file KEK.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS google_client_id TEXT,
ADD COLUMN IF NOT EXISTS google_client_secret_encrypted BYTEA,
ADD COLUMN IF NOT EXISTS google_client_secret_kek_version INTEGER,
ADD COLUMN IF NOT EXISTS google_redirect_uri TEXT,
ADD COLUMN IF NOT EXISTS google_updated_at TIMESTAMPTZ,
-- Bumped on every change so each process can tell its cached client is stale.
ADD COLUMN IF NOT EXISTS google_config_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_google_complete;
ALTER TABLE app_settings
ADD CONSTRAINT app_settings_google_complete CHECK (
    (
        google_client_id IS NULL AND google_client_secret_encrypted IS NULL
        AND google_client_secret_kek_version IS NULL AND google_redirect_uri IS NULL
    )
    OR (
        google_client_id IS NOT NULL AND google_client_secret_encrypted IS NOT NULL
        AND google_client_secret_kek_version IS NOT NULL AND google_redirect_uri IS NOT NULL
    )
);
