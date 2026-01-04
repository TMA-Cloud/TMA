# Audit Issues

Troubleshooting audit logging problems.

## Audit Events Not Logging

### Worker Not Running

**Check:**

1. Verify audit worker is running: `npm run worker`
2. Check worker logs for errors
3. Verify worker in Docker: `docker compose ps`

**Solutions:**

1. Start audit worker: `npm run worker`
2. Check worker logs
3. Verify environment variables

### Events Queued But Not Processed

**Check:**

1. Worker is running
2. Database connection working
3. Queue status: Check `pgboss.job` table

**Solutions:**

1. Restart audit worker
2. Check database connection
3. Verify `AUDIT_WORKER_CONCURRENCY` setting

## Queue Issues

### Jobs Stuck

**Check:**

```sql
SELECT * FROM pgboss.job
WHERE name = 'audit-log' AND state = 'created'
ORDER BY createdon DESC;
```

**Solutions:**

1. Restart worker
2. Check for database locks
3. Verify job TTL settings

## Related Topics

- [Audit Logs](/guides/operations/audit-logs) - Audit system
- [Background Workers](/guides/operations/background-workers) - Worker management
