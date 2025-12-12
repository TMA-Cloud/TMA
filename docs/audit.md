# Audit Logging System

Comprehensive audit trail documentation for TMA Cloud.

## Overview

TMA Cloud includes a robust audit logging system that tracks all critical user actions and system events. The system uses a queue-based architecture with PostgreSQL and pg-boss to ensure audit events are reliably captured without impacting application performance.

### Key Features

- **Complete Audit Trail**: Track all file operations, shares, authentication, and admin actions
- **Asynchronous Processing**: Queue-based system prevents performance impact
- **Rich Metadata**: Detailed information about each event (file names, IDs, types, destinations)
- **PostgreSQL Storage**: Persistent, queryable audit logs
- **User Attribution**: Every event linked to user who performed it
- **Resource Tracking**: Track operations on files, folders, shares, and users
- **Status Tracking**: Success and failure states for all operations

## Configuration

### Environment Variables

```bash
# Worker concurrency (default: 5)
AUDIT_WORKER_CONCURRENCY=5

# Audit job TTL (must be < 24h; default 23h = 82800 seconds)
AUDIT_JOB_TTL_SECONDS=82800
```

### Starting the Audit Worker

The audit worker must be running to process audit events:

```bash
# Start audit worker
npm run worker

# Or with PM2
pm2 start audit-worker.js --name audit-worker
```

**Important:** Audit events are queued but not written to the database until the worker processes them. Always keep the audit worker running in production.

## Audit Events

### Authentication Events

#### `user.signup`

User creates new account.

**Metadata:**

```json
{
  "email": "user@example.com",
  "method": "email" // or "google"
}
```

#### `user.login`

User logs in successfully.

**Metadata:**

```json
{
  "email": "user@example.com",
  "method": "email" // or "google"
}
```

#### `user.logout`

User logs out.

**Metadata:**

```json
{
  "email": "user@example.com"
}
```

#### `user.login.failed`

Failed login attempt.

**Metadata:**

```json
{
  "email": "user@example.com",
  "reason": "invalid_credentials"
}
```

### File Events

#### `file.upload`

File uploaded to storage.

**Resource:** `file`

**Metadata:**

```json
{
  "fileName": "document.pdf",
  "fileSize": 1024000,
  "mimeType": "application/pdf",
  "parentId": "folder_123"
}
```

#### `file.download`

File downloaded by user.

**Resource:** `file`

**Metadata:**

```json
{
  "fileName": "document.pdf",
  "fileSize": 1024000,
  "fileType": "application/pdf"
}
```

#### `file.delete`

File moved to trash.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "fileCount": 3,
  "fileIds": ["file_1", "file_2", "file_3"],
  "fileNames": ["doc1.pdf", "doc2.pdf", "doc3.pdf"],
  "fileTypes": ["application/pdf", "application/pdf", "application/pdf"],
  "permanent": false
}
```

#### `file.delete.permanent`

File permanently deleted from trash.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "fileCount": 2,
  "fileIds": ["file_1", "file_2"],
  "fileNames": ["old-file.pdf", "archive.zip"],
  "fileTypes": ["application/pdf", "application/zip"],
  "permanent": true
}
```

#### `file.restore`

File restored from trash.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "fileCount": 1,
  "fileIds": ["file_123"],
  "fileNames": ["recovered.docx"],
  "fileTypes": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
}
```

#### `file.rename`

File or folder renamed.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "oldName": "draft.docx",
  "newName": "final-report.docx"
}
```

#### `file.move`

Files or folders moved to different location.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "fileCount": 2,
  "fileIds": ["file_1", "file_2"],
  "fileNames": ["doc1.pdf", "doc2.pdf"],
  "fileTypes": ["application/pdf", "application/pdf"],
  "targetParentId": "folder_456",
  "targetFolderName": "Reports"
}
```

#### `file.copy`

Files or folders copied.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "fileCount": 1,
  "fileIds": ["file_123"],
  "fileNames": ["template.xlsx"],
  "fileTypes": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  "targetParentId": "folder_789",
  "targetFolderName": "Templates"
}
```

#### `file.star`

File or folder starred.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "fileCount": 3,
  "fileIds": ["file_1", "file_2", "folder_3"],
  "fileNames": ["important.pdf", "contract.docx", "Projects"],
  "fileTypes": ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "folder"],
  "starred": true
}
```

#### `file.unstar`

File or folder unstarred.

**Resource:** `file` or `folder`

**Metadata:**

```json
{
  "fileCount": 1,
  "fileIds": ["file_123"],
  "fileNames": ["old-project.pdf"],
  "fileTypes": ["application/pdf"],
  "starred": false
}
```

### Folder Events

#### `folder.create`

New folder created.

**Resource:** `folder`

**Metadata:**

```json
{
  "folderName": "New Project",
  "parentId": "folder_123"
}
```

### Share Events

#### `share.create`

Share link created for file or folder.

**Resource:** `share`

**Metadata:**

```json
{
  "fileId": "file_123",
  "fileCount": 5,
  "expiresAt": "2025-12-31T23:59:59Z"
}
```

#### `share.delete`

Share link removed/revoked.

**Resource:** `share`

**Metadata:**

```json
{
  "fileId": "file_123"
}
```

#### `share.access`

Public user accessed shared file/folder.

**Resource:** `share`

**Metadata:**

```json
{
  "fileId": "file_123",
  "fileName": "shared-document.pdf",
  "shareToken": "abc12345"
}
```

### Document Events (OnlyOffice)

#### `document.open`

Document opened in OnlyOffice editor.

**Resource:** `file`

**Metadata:**

```json
{
  "fileName": "report.docx",
  "fileType": "docx",
  "mode": "edit" // or "view"
}
```

#### `document.save`

Document saved from OnlyOffice editor.

**Resource:** `file`

**Metadata:**

```json
{
  "fileName": "report.docx",
  "fileSize": 2048000,
  "oldSize": 1024000,
  "savedVia": "onlyoffice"
}
```

### Settings Events

#### `settings.signup.toggle`

Signup enabled/disabled by first user.

**Resource:** `settings`

**Metadata:**

```json
{
  "newStatus": false,
  "changedBy": "user_001"
}
```

## Querying Audit Logs

### View All Audit Logs

```sql
SELECT * FROM audit_logs
ORDER BY created_at DESC
LIMIT 100;
```

### View User Activity

```sql
SELECT event_type, status, resource_type, metadata, created_at
FROM audit_logs
WHERE user_id = 'user_abc123'
ORDER BY created_at DESC;
```

### View Failed Operations

```sql
SELECT event_type, user_id, resource_type, metadata, created_at
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

### View Authentication Events

```sql
SELECT event_type, user_id, ip_address, metadata->>'email' as email, created_at
FROM audit_logs
WHERE event_type IN ('user.login', 'user.login.failed', 'user.logout')
ORDER BY created_at DESC;
```

### View Share Access

```sql
SELECT
  metadata->>'fileName' as file_name,
  metadata->>'shareToken' as token,
  ip_address,
  created_at
FROM audit_logs
WHERE event_type = 'share.access'
ORDER BY created_at DESC;
```

### Search by Metadata

```sql
-- Find all operations on a specific file
SELECT * FROM audit_logs
WHERE metadata @> '{"fileId": "file_123"}'::jsonb
ORDER BY created_at DESC;

-- Find large file uploads
SELECT
  user_id,
  metadata->>'fileName' as file_name,
  metadata->>'fileSize' as size,
  created_at
FROM audit_logs
WHERE event_type = 'file.upload'
  AND (metadata->>'fileSize')::bigint > 10485760  -- 10MB
ORDER BY created_at DESC;
```

### Activity by Date Range

```sql
SELECT event_type, COUNT(*) as count
FROM audit_logs
WHERE created_at BETWEEN '2025-01-01' AND '2025-01-31'
GROUP BY event_type
ORDER BY count DESC;
```

## Logging Audit Events in Code

### Basic Usage

```javascript
const { logAuditEvent } = require('../services/auditLogger');

// In controller
await logAuditEvent('file.upload', {
  status: 'success',
  resourceType: 'file',
  resourceId: file.id,
  metadata: {
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type
  }
}, req);
```

### Parameters

```javascript
logAuditEvent(eventType, eventData, req)
```

**eventType** (string): Event type identifier (e.g., `file.upload`)

**eventData** (object):

- `status` (string): `'success'` or `'failure'`
- `resourceType` (string): Type of resource (e.g., `'file'`, `'folder'`, `'share'`)
- `resourceId` (string): ID of the resource
- `metadata` (object): Additional event-specific data

**req** (object): Express request object (for user ID, IP, user agent)

## Audit Worker Management

### Start Worker

```bash
npm run worker
```

### Monitor Worker

Worker logs show processing status:

```bash
[INFO] Audit worker started
[INFO] Processing audit event: file.upload
[INFO] Audit event logged: file.upload for user user_123
```

### Worker Concurrency

Control how many events are processed simultaneously:

```bash
AUDIT_WORKER_CONCURRENCY=10
```

Higher values:

- ✅ Faster processing
- ❌ More database connections

Recommended: 5-10 for most deployments

### Check Queue Status

```sql
-- View pending jobs
SELECT * FROM pgboss.job
WHERE name = 'audit-log'
  AND state = 'created'
ORDER BY createdon DESC;

-- View completed jobs
SELECT * FROM pgboss.job
WHERE name = 'audit-log'
  AND state = 'completed'
ORDER BY completedon DESC
LIMIT 100;
```

## Related Documentation

- [Logging System](logging.md) - Application logging
- [Database Schema](database.md) - Database structure
- [Environment Variables](environment.md) - Configuration
- [Security Features](features.md#security-features) - Security overview

## External Resources

- [pg-boss Documentation](https://github.com/timgit/pg-boss)
- [PostgreSQL JSONB](https://www.postgresql.org/docs/current/datatype-json.html)
- [Audit Logging Best Practices](https://owasp.org/www-community/controls/Audit_Logging)
