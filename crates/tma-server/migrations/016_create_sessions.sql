-- Migration: Create sessions table to track active user sessions
-- This allows users to see and manage their active sessions from the Settings page

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_version INTEGER NOT NULL,
    user_agent TEXT,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying active sessions by user
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id, created_at DESC);

-- Index for cleanup of expired sessions (based on token_version)
CREATE INDEX IF NOT EXISTS idx_sessions_user_token_version ON sessions(user_id, token_version);

-- Index for last activity tracking
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);

COMMENT ON TABLE sessions IS
    'Tracks active user sessions. Sessions are automatically invalidated when token_version changes.';
COMMENT ON COLUMN sessions.token_version IS
    'Token version when session was created. Sessions with outdated versions are considered invalid.';
COMMENT ON COLUMN sessions.last_activity IS
    'Last time this session was used. Updated on each authenticated request.';
