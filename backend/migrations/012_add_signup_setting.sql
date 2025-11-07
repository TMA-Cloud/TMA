-- Create app_settings table to store application-wide settings
CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY DEFAULT 'app_settings',
    signup_enabled BOOLEAN DEFAULT true,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add first_user_id column if it doesn't exist (for existing installations)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'app_settings' AND column_name = 'first_user_id'
    ) THEN
        ALTER TABLE app_settings 
        ADD COLUMN first_user_id TEXT UNIQUE,
        ADD CONSTRAINT fk_first_user FOREIGN KEY (first_user_id) 
            REFERENCES users(id) ON DELETE RESTRICT;
    END IF;
END $$;

-- Initialize with signup enabled by default
INSERT INTO app_settings (id, signup_enabled) 
VALUES ('app_settings', true)
ON CONFLICT (id) DO NOTHING;

-- If users already exist, set the first user
DO $$
DECLARE
    first_user_id_val TEXT;
BEGIN
    SELECT id INTO first_user_id_val FROM users ORDER BY created_at ASC LIMIT 1;
    IF first_user_id_val IS NOT NULL THEN
        UPDATE app_settings SET first_user_id = first_user_id_val WHERE id = 'app_settings' AND first_user_id IS NULL;
    END IF;
END $$;

