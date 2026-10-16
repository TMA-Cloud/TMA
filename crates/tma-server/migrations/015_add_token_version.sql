-- Migration: Add token_version to users table for session invalidation
-- This allows users to invalidate all their sessions by incrementing token_version

-- Add token_version column (defaults to 1 for existing users)
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 1 NOT NULL;

-- Add index for faster lookups during token validation
CREATE INDEX IF NOT EXISTS idx_users_token_version ON users(id, token_version);

-- Add last_token_invalidation timestamp to track when tokens were last invalidated
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_token_invalidation TIMESTAMP;
