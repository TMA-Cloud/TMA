-- Comprehensive audit log table for all user actions and system events
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,

    -- Request correlation (required for tracing)
    request_id TEXT NOT NULL,

    -- User identification (NULL for anonymous/system events)
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Event classification
    action TEXT NOT NULL,               -- e.g., 'file.upload', 'auth.login'
    resource_type TEXT,                 -- e.g., 'file', 'folder', 'share', 'user'
    resource_id TEXT,                   -- File ID, share ID, etc.

    -- Execution result
    status TEXT NOT NULL DEFAULT 'success',  -- 'success', 'failure', 'error'

    -- Request context
    ip_address INET,                    -- Client IP (PostgreSQL INET type for efficient storage)
    user_agent TEXT,                    -- Client user agent string

    -- Flexible metadata (action-specific details)
    metadata JSONB,                     -- Structured data (file size, share settings, etc.)

    -- Error tracking
    error_message TEXT,                 -- Error details if status = 'error'

    -- Performance tracking
    processing_time_ms INTEGER,         -- Operation duration

    -- Timestamp (auto-populated)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
-- Most queries filter by user + time range
CREATE INDEX idx_audit_log_user_activity
    ON audit_log(user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- Time-based queries (recent activity, cleanup)
CREATE INDEX idx_audit_log_created_at
    ON audit_log(created_at DESC);

-- Action-based filtering (e.g., all file uploads)
CREATE INDEX idx_audit_log_action
    ON audit_log(action);

-- Resource lookup (e.g., all actions on file_123)
CREATE INDEX idx_audit_log_resource
    ON audit_log(resource_type, resource_id)
    WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL;

-- Request tracing (find all events for a request)
CREATE INDEX idx_audit_log_request_id
    ON audit_log(request_id);

-- Partial index for monitoring failed operations (saves space)
CREATE INDEX idx_audit_log_failures
    ON audit_log(created_at DESC, action, error_message)
    WHERE status IN ('failure', 'error');

-- GIN index for JSON metadata queries (optional, for advanced filtering)
CREATE INDEX idx_audit_log_metadata
    ON audit_log USING GIN(metadata jsonb_path_ops);

-- Table and column comments for documentation
COMMENT ON TABLE audit_log IS
    'Comprehensive audit trail for all user actions and system events. Retention: 30 days.';
COMMENT ON COLUMN audit_log.metadata IS
    'JSON field for action-specific data (file size, share settings, etc.). Indexed with GIN.';
COMMENT ON COLUMN audit_log.request_id IS
    'Correlation ID for tracing requests across logs and services.';
