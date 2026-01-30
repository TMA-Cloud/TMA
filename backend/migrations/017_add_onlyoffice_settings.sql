-- Add OnlyOffice settings columns to app_settings table
DO $$
BEGIN
    -- Add onlyoffice_jwt_secret column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'app_settings' AND column_name = 'onlyoffice_jwt_secret'
    ) THEN
        ALTER TABLE app_settings 
        ADD COLUMN onlyoffice_jwt_secret TEXT;
    END IF;

    -- Add onlyoffice_url column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'app_settings' AND column_name = 'onlyoffice_url'
    ) THEN
        ALTER TABLE app_settings 
        ADD COLUMN onlyoffice_url TEXT;
    END IF;
END $$;
