-- Object storage is configured by the first user instead of the environment.
-- The secret access key is stored AES-256-GCM encrypted under the file KEK.
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS storage_provider TEXT,
ADD COLUMN IF NOT EXISTS storage_endpoint TEXT,
ADD COLUMN IF NOT EXISTS storage_region TEXT,
ADD COLUMN IF NOT EXISTS storage_bucket TEXT,
ADD COLUMN IF NOT EXISTS storage_force_path_style BOOLEAN,
ADD COLUMN IF NOT EXISTS storage_access_key_id TEXT,
ADD COLUMN IF NOT EXISTS storage_secret_encrypted BYTEA,
ADD COLUMN IF NOT EXISTS storage_secret_kek_version INTEGER,
ADD COLUMN IF NOT EXISTS storage_updated_at TIMESTAMPTZ,
-- Bumped on every change so each process can tell its cached client is stale.
ADD COLUMN IF NOT EXISTS storage_config_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_storage_complete;
ALTER TABLE app_settings
ADD CONSTRAINT app_settings_storage_complete CHECK (
    (
        storage_provider IS NULL AND storage_endpoint IS NULL AND storage_region IS NULL
        AND storage_bucket IS NULL AND storage_force_path_style IS NULL AND storage_access_key_id IS NULL
        AND storage_secret_encrypted IS NULL AND storage_secret_kek_version IS NULL
    )
    OR (
        storage_provider IN ('s3', 'r2', 'aws') AND storage_endpoint IS NOT NULL AND storage_region IS NOT NULL
        AND storage_bucket IS NOT NULL AND storage_force_path_style IS NOT NULL
        AND storage_access_key_id IS NOT NULL AND storage_secret_encrypted IS NOT NULL
        AND storage_secret_kek_version IS NOT NULL
    )
);
