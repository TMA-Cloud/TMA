# Database Schema

PostgreSQL database schema for TMA Cloud.

## Tables

### `users`

User accounts.

| Column                    | Type         | Description                  |
| ------------------------- | ------------ | ---------------------------- |
| `id`                      | VARCHAR(255) | Primary key                  |
| `email`                   | VARCHAR(255) | Unique, not null             |
| `password`                | VARCHAR(255) | Hashed (nullable for OAuth)  |
| `name`                    | VARCHAR(255) | Display name                 |
| `google_id`               | VARCHAR(255) | Unique (optional)            |
| `mfa_enabled`             | BOOLEAN      | Default false                |
| `mfa_secret`              | TEXT         | TOTP secret (nullable)       |
| `token_version`           | INTEGER      | Token version for revocation |
| `last_token_invalidation` | TIMESTAMP    | Last token invalidation time |
| `created_at`              | TIMESTAMPTZ  | Default now()                |
| `updated_at`              | TIMESTAMPTZ  | Default now()                |

### `files`

Files and folders.

| Column       | Type         | Description                   |
| ------------ | ------------ | ----------------------------- |
| `id`         | VARCHAR(255) | Primary key                   |
| `name`       | VARCHAR(255) | Not null                      |
| `type`       | VARCHAR(50)  | 'file' or 'folder'            |
| `size`       | BIGINT       | File size in bytes            |
| `mime_type`  | VARCHAR(255) | MIME type                     |
| `user_id`    | VARCHAR(255) | FK → users.id                 |
| `parent_id`  | VARCHAR(255) | FK → files.id (null for root) |
| `path`       | TEXT         | Full path                     |
| `starred`    | BOOLEAN      | Default false                 |
| `deleted_at` | TIMESTAMPTZ  | Soft delete timestamp         |
| `modified`   | TIMESTAMPTZ  | Last modification time        |

**Indexes:** `user_id`, `parent_id`, `path`, `deleted_at`, full-text on `name`

### `share_links`

Share link metadata.

| Column       | Type         | Description                       |
| ------------ | ------------ | --------------------------------- |
| `id`         | VARCHAR(255) | Primary key                       |
| `token`      | VARCHAR(255) | Unique, not null                  |
| `user_id`    | VARCHAR(255) | FK → users.id                     |
| `expires_at` | TIMESTAMPTZ  | Expiration (null = no expiration) |
| `created_at` | TIMESTAMPTZ  | Default now()                     |

### `share_link_files`

Junction table linking share links to files.

| Column          | Type         | Description         |
| --------------- | ------------ | ------------------- |
| `share_link_id` | VARCHAR(255) | FK → share_links.id |
| `file_id`       | VARCHAR(255) | FK → files.id       |
| `created_at`    | TIMESTAMPTZ  | Default now()       |

**Primary Key:** (`share_link_id`, `file_id`)

### `app_settings`

Application-wide settings.

| Column           | Type        | Description                         |
| ---------------- | ----------- | ----------------------------------- |
| `id`             | TEXT        | Primary key (always 'app_settings') |
| `signup_enabled` | BOOLEAN     | Default true                        |
| `first_user_id`  | TEXT        | FK → users.id (immutable)           |
| `updated_at`     | TIMESTAMPTZ | Default now()                       |

### `sessions`

Active user sessions.

| Column          | Type        | Description                             |
| --------------- | ----------- | --------------------------------------- |
| `id`            | TEXT        | Primary key                             |
| `user_id`       | TEXT        | FK → users.id                           |
| `token_version` | INTEGER     | Token version when created              |
| `user_agent`    | TEXT        | Browser user agent                      |
| `ip_address`    | INET        | Client IP                               |
| `created_at`    | TIMESTAMPTZ | Default now()                           |
| `last_activity` | TIMESTAMPTZ | Default now() (updates on each request) |

**Indexes:** `(user_id, created_at DESC)`, `(user_id, token_version)`, `last_activity`

### `audit_logs`

Audit trail events.

| Column          | Type         | Description               |
| --------------- | ------------ | ------------------------- |
| `id`            | SERIAL       | Primary key               |
| `event_type`    | VARCHAR(100) | Event type                |
| `user_id`       | VARCHAR(16)  | FK → users.id (nullable)  |
| `status`        | VARCHAR(20)  | 'success' or 'failure'    |
| `resource_type` | VARCHAR(50)  | Resource type             |
| `resource_id`   | VARCHAR(255) | Resource ID               |
| `ip_address`    | INET         | Client IP                 |
| `user_agent`    | TEXT         | Browser user agent        |
| `metadata`      | JSONB        | Event-specific data       |
| `created_at`    | TIMESTAMP    | Default CURRENT_TIMESTAMP |

**Indexes:** `user_id`, `event_type`, `created_at`, `(resource_type, resource_id)`

### `pgboss.*`

pg-boss job queue tables (managed automatically).

### `migrations`

Migration tracking.

| Column       | Type         | Description   |
| ------------ | ------------ | ------------- |
| `version`    | VARCHAR(255) | Primary key   |
| `applied_at` | TIMESTAMPTZ  | Default now() |

## Relationships

- User → Files (one-to-many, CASCADE)
- File → Files (parent-child, self-referential, CASCADE)
- User → Share Links (one-to-many, CASCADE)
- Share Link → Files (many-to-many via `share_link_files`)
- User → Sessions (one-to-many, CASCADE)
- User → Audit Logs (one-to-many, SET NULL)

## Common Queries

**List user files:**

```sql
SELECT * FROM files
WHERE user_id = $1 AND parent_id = $2 AND deleted_at IS NULL
ORDER BY type, name;
```

**Search files:**

```sql
SELECT * FROM files
WHERE user_id = $1 AND deleted_at IS NULL
  AND (
    lower(name) LIKE lower($2) || '%'
    OR (lower(name) LIKE '%' || lower($2) || '%'
        AND similarity(lower(name), lower($2)) > 0.15)
  )
ORDER BY
  CASE
    WHEN lower(name) = lower($2) THEN 1
    WHEN lower(name) LIKE lower($2) || '%' THEN 2
    ELSE 3
  END ASC,
  similarity(lower(name), lower($2)) DESC NULLS LAST,
  modified DESC;
```

**Query audit logs:**

```sql
SELECT event_type, status, metadata, created_at
FROM audit_logs
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 100;
```

## Related Topics

- [Architecture](/concepts/architecture) - System architecture
- [Audit Events](audit-events.md) - Audit event types
