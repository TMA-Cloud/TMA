-- The desktop-only setting is named for what it does, not for the Electron app it
-- once meant.
ALTER TABLE app_settings RENAME COLUMN require_electron_client TO desktop_only;
