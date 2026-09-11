-- Forward migration for installations that already recorded migration 014.
-- Keep each delete bounded to limit locks, WAL spikes, and long transactions.
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
    cutoff_date TIMESTAMPTZ;
BEGIN
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

    WITH doomed AS (
        SELECT id
          FROM audit_log
         WHERE created_at < cutoff_date
         ORDER BY created_at
         LIMIT 10000
    )
    DELETE FROM audit_log a USING doomed d WHERE a.id = d.id;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_audit_logs IS
    'Deletes up to 10,000 expired audit rows per call and returns the number deleted.';
