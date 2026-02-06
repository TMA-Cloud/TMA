# Audit Logs

Comprehensive audit trail system in TMA Cloud.

## Overview

Queue-based audit logging system using PostgreSQL and pg-boss. Tracks all critical user actions and system events asynchronously.

## Configuration

### Environment Variables

```bash
AUDIT_WORKER_CONCURRENCY=5  # Concurrent events processed
AUDIT_JOB_TTL_SECONDS=82800  # Job TTL (must be < 24h)
```

### Starting the Audit Worker

```bash
npm run worker
```

**Important:** Audit events are queued but not written to database until worker processes them. Always keep worker running in production.

## Audit Events

### Authentication Events

- `user.signup` - User creates account
- `user.login` - User logs in
- `user.logout` - User logs out
- `user.login.failed` - Failed login attempt
- `auth.logout` - Session logout
- `auth.logout_all` - Logout from all devices
- `auth.suspicious_token` - Token fingerprint mismatch
- `auth.session_revoked` - Session revoked

### File Events

- `file.upload` - File uploaded
- `file.download` - File downloaded
- `file.delete` - File moved to trash
- `file.delete.permanent` - File permanently deleted
- `file.restore` - File restored from trash
- `file.rename` - File/folder renamed
- `file.move` - Files/folders moved
- `file.copy` - Files/folders copied
- `file.star` / `file.unstar` - File starred/unstarred

### Folder Events

- `folder.create` - Folder created

### Share Events

- `share.create` - Share link created
- `share.delete` - Share link removed
- `share.access` - Public access to shared file/folder

### Document Events (OnlyOffice)

- `document.open` - Document opened in OnlyOffice
- `document.save` - Document saved from OnlyOffice

### Settings Events

- `admin.settings.update` - Admin setting changed (e.g. signup enabled/disabled)
- `admin.settings.read` - Admin read of protected settings

## Querying Audit Logs

### View User Activity

```sql
SELECT event_type, status, metadata, created_at
FROM audit_logs
WHERE user_id = 'user_abc123'
ORDER BY created_at DESC;
```

### View Failed Operations

```sql
SELECT event_type, user_id, metadata, created_at
FROM audit_logs
WHERE status = 'failure'
ORDER BY created_at DESC;
```

### View File Operations

```sql
SELECT event_type, user_id, metadata->>'fileName' as file_name, created_at
FROM audit_logs
WHERE resource_type = 'file'
  AND event_type LIKE 'file.%'
ORDER BY created_at DESC;
```

### Search by Metadata

```sql
-- Find operations on specific file
SELECT * FROM audit_logs
WHERE metadata @> '{"fileId": "file_123"}'::jsonb
ORDER BY created_at DESC;

-- Find large file uploads
SELECT user_id, metadata->>'fileName' as file_name,
       (metadata->>'fileSize')::bigint as size, created_at
FROM audit_logs
WHERE event_type = 'file.upload'
  AND (metadata->>'fileSize')::bigint > 10485760
ORDER BY created_at DESC;
```

## Audit Worker Management

### Monitor Worker

```bash
npm run worker
# Logs show: "Audit worker started", "Processing audit event: ..."
```

### Check Queue Status

```sql
-- View pending jobs
SELECT * FROM pgboss.job
WHERE name = 'audit-log' AND state = 'created'
ORDER BY createdon DESC;

-- View completed jobs
SELECT * FROM pgboss.job
WHERE name = 'audit-log' AND state = 'completed'
ORDER BY completedon DESC LIMIT 100;
```

### Worker Concurrency

Higher values = faster processing but more database connections. Recommended: 5-10.

## Related Topics

- [Logging](logging.md) - Application logging
- [Monitoring](monitoring.md) - System monitoring
- [Reference: Audit Events](/reference/audit-events) - Complete event list
