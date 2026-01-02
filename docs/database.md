# Database Schema

Complete database schema documentation for TMA Cloud.

## Overview

TMA Cloud uses PostgreSQL as the database. The schema is managed through migration files in `backend/migrations/`.

## Tables

### `users`

Stores user account information.

| Column         | Type         | Constraints              | Description                                  |
|----------------|--------------|--------------------------|----------------------------------------------|
| `id`           | VARCHAR(255) | PRIMARY KEY              | Unique user identifier                       |
| `email`        | VARCHAR(255) | UNIQUE, NOT NULL         | User email address                           |
| `password`     | VARCHAR(255) |                          | Hashed password (nullable for OAuth users)   |
| `name`         | VARCHAR(255) | NOT NULL                 | User display name                            |
| `google_id`    | VARCHAR(255) | UNIQUE                   | Google OAuth ID (optional)                   |
| `created_at`   | TIMESTAMPTZ  | NOT NULL, DEFAULT now()  | Account creation timestamp                   |
| `updated_at`   | TIMESTAMPTZ  | NOT NULL, DEFAULT now()  | Last update timestamp                        |

**Indexes:**

- Primary key on `id`
- Unique index on `email`
- Unique index on `google_id` (where not null)

### `files`

Stores files and folders.

| Column         | Type         | Constraints              | Description                                    |
|----------------|--------------|--------------------------|------------------------------------------------|
| `id`           | VARCHAR(255) | PRIMARY KEY              | Unique file identifier                         |
| `name`         | VARCHAR(255) | NOT NULL                 | File or folder name                            |
| `type`         | VARCHAR(50)  | NOT NULL                 | 'file' or 'folder'                             |
| `size`         | BIGINT       | DEFAULT 0                | File size in bytes                             |
| `mime_type`    | VARCHAR(255) |                          | MIME type for files                            |
| `user_id`      | VARCHAR(255) | NOT NULL, FK → users.id  | Owner user ID                                  |
| `parent_id`    | VARCHAR(255) | FK → files.id            | Parent folder ID (null for root)               |
| `path`         | TEXT         |                          | Full path to file                              |
| `starred`      | BOOLEAN      | DEFAULT false            | Starred status                                 |
| `deleted_at`   | TIMESTAMPTZ  |                          | Soft delete timestamp (null if not deleted)    |
| `created_at`   | TIMESTAMPTZ  | NOT NULL, DEFAULT now()  | Creation timestamp                             |
| `updated_at`   | TIMESTAMPTZ  | NOT NULL, DEFAULT now()  | Last update timestamp                          |

**Indexes:**

- Primary key on `id`
- Index on `user_id`
- Index on `parent_id`
- Index on `path` (for search)
- Index on `deleted_at` (for trash queries)
- Full-text search index on `name`

**Foreign Keys:**

- `user_id` → `users.id` (ON DELETE CASCADE)
- `parent_id` → `files.id` (ON DELETE CASCADE)

### `share_links`

Stores share link metadata.

| Column        | Type          | Constraints              | Description                                   |
|---------------|---------------|--------------------------|-----------------------------------------------|
| `id`          | VARCHAR(255)  | PRIMARY KEY              | Unique share link ID                          |
| `token`       | VARCHAR(255)  | UNIQUE, NOT NULL         | Public share token                            |
| `user_id`     | VARCHAR(255)  | NOT NULL, FK → users.id  | Creator user ID                               |
| `expires_at`  | TIMESTAMPTZ   |                          | Expiration timestamp (null = no expiration)   |
| `created_at`  | TIMESTAMPTZ   | NOT NULL, DEFAULT now()  | Creation timestamp                            |

**Indexes:**

- Primary key on `id`
- Unique index on `token`
- Index on `user_id`

**Foreign Keys:**

- `user_id` → `users.id` (ON DELETE CASCADE)

### `share_link_files`

Junction table linking share links to files.

| Column          | Type          | Constraints                    | Description              |
|-----------------|---------------|--------------------------------|--------------------------|
| `share_link_id` | VARCHAR(255)  | NOT NULL, FK → share_links.id  | Share link ID            |
| `file_id`       | VARCHAR(255)  | NOT NULL, FK → files.id        | File ID                  |
| `created_at`    | TIMESTAMPTZ   | NOT NULL, DEFAULT now()        | Link creation timestamp  |

**Indexes:**

- Composite primary key on (`share_link_id`, `file_id`)
- Index on `share_link_id`
- Index on `file_id`

**Foreign Keys:**

- `share_link_id` → `share_links.id` (ON DELETE CASCADE)
- `file_id` → `files.id` (ON DELETE CASCADE)

### `app_settings`

Stores application-wide settings.

| Column           | Type         | Constraints             | Description                                   |
|------------------|--------------|-------------------------|-----------------------------------------------|
| `id`             | TEXT         | PRIMARY KEY             | Settings identifier (always 'app_settings')   |
| `signup_enabled` | BOOLEAN      | DEFAULT true            | Whether new user registration is enabled      |
| `first_user_id`  | TEXT         | UNIQUE, FK → users.id   | Immutable ID of the first user (set once)     |
| `updated_at`     | TIMESTAMPTZ  | DEFAULT now()           | Last update timestamp                         |

**Indexes:**

- Primary key on `id`
- Unique index on `first_user_id`

**Foreign Keys:**

- `first_user_id` → `users.id` (ON DELETE RESTRICT) - Prevents deletion of first user

**Notes:**

- Only one row exists in this table (id = 'app_settings')
- `first_user_id` is set when the first user signs up and cannot be changed afterward
- The foreign key constraint with `ON DELETE RESTRICT` prevents deletion of the first user

### `sessions`

Stores active user sessions for session management and revocation.

| Column           | Type         | Constraints              | Description                                         |
|------------------|--------------|--------------------------|-----------------------------------------------------|
| `id`             | TEXT         | PRIMARY KEY              | Unique session identifier                           |
| `user_id`        | TEXT         | NOT NULL, FK → users.id  | User who owns this session                          |
| `token_version`  | INTEGER      | NOT NULL                 | Token version when session was created              |
| `user_agent`     | TEXT         |                          | Browser/client user agent string                    |
| `ip_address`     | INET         |                          | IP address of client                                |
| `created_at`     | TIMESTAMPTZ  | NOT NULL, DEFAULT now()  | Session creation timestamp                          |
| `last_activity`  | TIMESTAMPTZ  | NOT NULL, DEFAULT now()  | Last activity timestamp (updates on each request)   |

**Indexes:**

- Primary key on `id`
- Index on `(user_id, created_at DESC)` - Fast lookup of user's sessions
- Index on `(user_id, token_version)` - Filter active sessions by token version
- Index on `last_activity` - For cleanup of old sessions

**Foreign Keys:**

- `user_id` → `users.id` (ON DELETE CASCADE) - Sessions deleted when user is deleted

**Notes:**

- Sessions are created on login/signup with a unique session ID
- Session ID is embedded in JWT tokens for validation
- Only sessions with the current `token_version` are considered active
- `last_activity` is updated automatically on each authenticated request
- Old sessions are cleaned up periodically (30-day retention)
- Sessions are deleted when user logs out from all devices
- Individual sessions can be revoked, which deletes the session record

### `audit_logs`

Stores audit trail of all user actions and system events.

| Column           | Type          | Constraints                | Description                                                     |
|------------------|---------------|----------------------------|-----------------------------------------------------------------|
| `id`             | SERIAL        | PRIMARY KEY                | Auto-incrementing audit log ID                                  |
| `event_type`     | VARCHAR(100)  | NOT NULL                   | Event type (e.g., 'user.login', 'file.upload')                  |
| `user_id`        | VARCHAR(16)   | FK → users.id              | User who performed the action (null for anonymous)              |
| `status`         | VARCHAR(20)   | NOT NULL                   | Event status ('success', 'failure')                             |
| `resource_type`  | VARCHAR(50)   |                            | Type of resource affected (e.g., 'file', 'folder', 'share')     |
| `resource_id`    | VARCHAR(255)  |                            | ID of affected resource                                         |
| `ip_address`     | INET          |                            | IP address of client                                            |
| `user_agent`     | TEXT          |                            | Browser/client user agent                                       |
| `metadata`       | JSONB         |                            | Additional event-specific data (searchable)                     |
| `created_at`     | TIMESTAMP     | DEFAULT CURRENT_TIMESTAMP  | When event occurred                                             |

**Indexes:**

- Primary key on `id`
- Index on `user_id` (for user activity queries)
- Index on `event_type` (for filtering by event type)
- Index on `created_at` (for time-based queries)
- Composite index on (`resource_type`, `resource_id`) (for resource tracking)

**Foreign Keys:**

- `user_id` → `users.id` (ON DELETE SET NULL) - Preserves audit logs even if user deleted

**Notes:**

- JSONB `metadata` column allows flexible storage of event-specific data
- Use JSONB operators for querying metadata: `metadata @> '{"fileName": "doc.pdf"}'::jsonb`
- Events are queued via pg-boss and processed asynchronously by audit worker

### `pgboss.*` Tables

pg-boss creates several tables for job queue management (prefixed with `pgboss.`):

**Key Tables:**

- `pgboss.job` - Job queue entries
- `pgboss.schedule` - Scheduled jobs
- `pgboss.subscription` - Job subscriptions
- `pgboss.archive` - Completed/failed jobs archive
- `pgboss.version` - pg-boss schema version

**Notes:**

- These tables are managed automatically by pg-boss
- Used for asynchronous audit event processing
- Jobs in queue until processed by audit worker
- See [pg-boss documentation](https://github.com/timgit/pg-boss) for details

### `migrations`

Tracks applied database migrations.

| Column        | Type          | Constraints               | Description                      |
|---------------|---------------|---------------------------|----------------------------------|
| `version`     | VARCHAR(255)  | PRIMARY KEY               | Migration version identifier     |
| `applied_at`  | TIMESTAMPTZ   | NOT NULL, DEFAULT now()   | Migration application timestamp  |

**Indexes:**

- Primary key on `version`

## Relationships

### User → Files

- One-to-many relationship
- A user can own many files
- Files are deleted when user is deleted (CASCADE)

### File → Files (Parent-Child)

- Self-referential relationship
- A file can have one parent folder
- A folder can have many child files/folders
- Files are deleted when parent is deleted (CASCADE)

### User → Share Links

- One-to-many relationship
- A user can create many share links
- Share links are deleted when user is deleted (CASCADE)

### Share Link → Files

- Many-to-many relationship
- A share link can include many files
- A file can be in many share links
- Junction table: `share_link_files`

### User → Sessions

- One-to-many relationship
- A user can have many active sessions
- Sessions are deleted when user is deleted (CASCADE)
- Each session is bound to a specific token version

### User → Audit Logs

- One-to-many relationship
- A user can have many audit log entries
- Audit logs are preserved when user is deleted (SET NULL)
- Allows historical tracking even after user deletion

## Data Types

### Identifiers

- All IDs use `VARCHAR(255)` for flexibility
- IDs are generated using custom ID generation utilities
- UUIDs or other formats can be used

### Timestamps

- All timestamps use `TIMESTAMPTZ` (timestamp with timezone)
- Default to `now()` for creation timestamps
- Updated timestamps should be maintained by application

### File Sizes

- File sizes stored as `BIGINT` (supports files up to 9 exabytes)
- Stored in bytes

## Indexes

### Performance Indexes

1. **User Files Query:**
   - `files.user_id` - Fast lookup of user's files
   - `files.deleted_at` - Filter active vs deleted files

2. **Folder Navigation:**
   - `files.parent_id` - Fast lookup of folder contents

3. **Search:**
   - Full-text search index on `files.name`
   - `files.path` index for path-based queries

4. **Share Links:**
   - `share_links.token` - Fast lookup by share token
   - `share_link_files.share_link_id` - Fast file lookup for shares

5. **Sessions:**
   - `sessions.user_id` - Fast lookup of user's sessions
   - `sessions.token_version` - Filter active sessions by token version
   - `sessions.last_activity` - Time-based queries and cleanup

6. **Audit Logs:**
   - `audit_logs.user_id` - Fast lookup of user activity
   - `audit_logs.event_type` - Filter by event type
   - `audit_logs.created_at` - Time-based queries and sorting
   - Composite (`resource_type`, `resource_id`) - Track operations on specific resources

## Constraints

### Unique Constraints

- `users.email` - One account per email
- `users.google_id` - One account per Google ID
- `share_links.token` - Unique share tokens
- Composite unique on `share_link_files(share_link_id, file_id)`

### Foreign Key Constraints

- Most foreign keys use `ON DELETE CASCADE` to maintain referential integrity
- Deleting a user deletes all their files and share links
- Deleting a folder deletes all child files/folders
- **Exception**: `app_settings.first_user_id` uses `ON DELETE RESTRICT` to prevent deletion of the first user

## Migrations

Migrations are stored in `backend/migrations/` and applied automatically on server startup.

### Migration Files

1. `001_create_files.sql` - Initial files table
2. `002_create_users.sql` - Users table
3. `003_change_files_id.sql` - Update file ID format
4. `004_add_parent_id.sql` - Add parent folder support
5. `005_add_user_id.sql` - Add user ownership
6. `006_add_path.sql` - Add path column
7. `007_create_share_links.sql` - Share links table
8. `008_create_share_link_files.sql` - Share link files junction
9. `009_add_deleted_at.sql` - Soft delete support
10. `010_add_google_auth.sql` - Google OAuth support
11. `011_add_search_index.sql` - Full-text search index
12. `012_add_signup_setting.sql` - Signup control settings table
13. `013_create_audit_log.sql` - Audit logs table with indexes
14. `014_audit_retention.sql` - Audit log retention policy and cleanup
15. `015_add_token_version.sql` - Token versioning for session invalidation
16. `016_create_sessions.sql` - Sessions table for active session management

## Query Patterns

### List User Files

```sql
SELECT * FROM files 
WHERE user_id = $1 
  AND parent_id = $2 
  AND deleted_at IS NULL
ORDER BY type, name;
```

### Search Files

```sql
SELECT * FROM files 
WHERE user_id = $1 
  AND deleted_at IS NULL
  AND to_tsvector('english', name) @@ to_tsquery('english', $2)
ORDER BY updated_at DESC;
```

### Get Share Link Files

```sql
SELECT f.* FROM files f
JOIN share_link_files slf ON f.id = slf.file_id
WHERE slf.share_link_id = $1
  AND f.deleted_at IS NULL;
```

### Query Audit Logs

**Get user activity:**

```sql
SELECT event_type, status, resource_type, metadata, created_at
FROM audit_logs
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 100;
```

**Get failed operations:**

```sql
SELECT event_type, user_id, resource_type, metadata, ip_address, created_at
FROM audit_logs
WHERE status = 'failure'
ORDER BY created_at DESC;
```

**Get file operations:**

```sql
SELECT event_type, user_id, metadata->>'fileName' as file_name, created_at
FROM audit_logs
WHERE resource_type = 'file'
  AND event_type LIKE 'file.%'
ORDER BY created_at DESC;
```

**Search metadata (JSONB):**

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

**Activity summary by date:**

```sql
SELECT event_type, COUNT(*) as count
FROM audit_logs
WHERE created_at BETWEEN $1 AND $2
GROUP BY event_type
ORDER BY count DESC;
```

## Backup and Maintenance

### Recommended Practices

1. **Regular Backups:**
   - Daily automated backups
   - Point-in-time recovery capability

2. **Index Maintenance:**
   - Periodic `VACUUM ANALYZE` for statistics
   - Reindex if needed
   - Monitor JSONB index performance on `audit_logs.metadata`

3. **Storage Monitoring:**
   - Monitor table sizes (especially `audit_logs` growth)
   - Archive old deleted files
   - Clean up expired share links
   - Implement audit log retention policy

4. **Audit Log Management:**
   - Monitor `audit_logs` table size
   - Set up retention policy (e.g., 1 year)
   - Archive old audit logs before deletion
   - Clean up pg-boss archive periodically
   - Monitor audit worker health

### Cleanup Queries

**Delete expired share links:**

```sql
DELETE FROM share_links
WHERE expires_at < NOW();
```

**Permanently delete old trash:**

```sql
DELETE FROM files
WHERE deleted_at < NOW() - INTERVAL '30 days';
```

**Archive old audit logs:**

```sql
-- Delete audit logs older than 1 year (adjust retention as needed)
DELETE FROM audit_logs
WHERE created_at < NOW() - INTERVAL '1 year';

-- Or archive to separate table before deletion
INSERT INTO audit_logs_archive
SELECT * FROM audit_logs
WHERE created_at < NOW() - INTERVAL '1 year';

DELETE FROM audit_logs
WHERE created_at < NOW() - INTERVAL '1 year';
```

**Clean up old pg-boss jobs:**

```sql
-- pg-boss automatically archives completed jobs
-- Check archive table size
SELECT COUNT(*) FROM pgboss.archive;

-- Clean up old archived jobs (optional)
DELETE FROM pgboss.archive
WHERE completedon < NOW() - INTERVAL '90 days';
```

### Monitoring Queries

**Check table sizes:**

```sql
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

**Monitor audit log growth:**

```sql
-- Count audit logs by day
SELECT DATE(created_at) as date, COUNT(*) as count
FROM audit_logs
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Count by event type
SELECT event_type, COUNT(*) as count
FROM audit_logs
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY event_type
ORDER BY count DESC;
```

**Check pg-boss queue status:**

```sql
-- Check pending jobs
SELECT state, COUNT(*) as count
FROM pgboss.job
WHERE name = 'audit-log'
GROUP BY state;

-- Check for stuck jobs
SELECT * FROM pgboss.job
WHERE name = 'audit-log'
  AND state = 'active'
  AND startedon < NOW() - INTERVAL '1 hour';
```
