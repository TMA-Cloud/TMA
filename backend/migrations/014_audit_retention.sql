-- Function to delete audit logs older than retention period
-- Called by scheduled cleanup service (backend/services/auditCleanup.js)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
    cutoff_date TIMESTAMPTZ;
BEGIN
    -- Calculate cutoff date
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

    -- Delete old audit logs
    DELETE FROM audit_log
    WHERE created_at < cutoff_date;

    -- Get count of deleted rows
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Log the cleanup operation to PostgreSQL logs
    RAISE NOTICE 'Deleted % audit log entries older than % (cutoff: %)',
        deleted_count, retention_days || ' days', cutoff_date;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_audit_logs IS
    'Deletes audit logs older than specified retention period (default 30 days). Returns count of deleted rows.';
