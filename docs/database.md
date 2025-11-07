# Database Schema

Complete database schema documentation for TMA Cloud.

## Overview

TMA Cloud uses PostgreSQL as the database. The schema is managed through migration files in `backend/migrations/`.

## Tables

### `users`

Stores user account information.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | VARCHAR(255) | PRIMARY KEY | Unique user identifier |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL | User email address |
| `password` | VARCHAR(255) | | Hashed password (nullable for OAuth users) |
| `name` | VARCHAR(255) | NOT NULL | User display name |
| `google_id` | VARCHAR(255) | UNIQUE | Google OAuth ID (optional) |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Account creation timestamp |
| `updated_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Last update timestamp |

**Indexes:**

- Primary key on `id`
- Unique index on `email`
- Unique index on `google_id` (where not null)

### `files`

Stores files and folders.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | VARCHAR(255) | PRIMARY KEY | Unique file identifier |
| `name` | VARCHAR(255) | NOT NULL | File or folder name |
| `type` | VARCHAR(50) | NOT NULL | 'file' or 'folder' |
| `size` | BIGINT | DEFAULT 0 | File size in bytes |
| `mime_type` | VARCHAR(255) | | MIME type for files |
| `user_id` | VARCHAR(255) | NOT NULL, FK → users.id | Owner user ID |
| `parent_id` | VARCHAR(255) | FK → files.id | Parent folder ID (null for root) |
| `path` | TEXT | | Full path to file |
| `starred` | BOOLEAN | DEFAULT false | Starred status |
| `deleted_at` | TIMESTAMPTZ | | Soft delete timestamp (null if not deleted) |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Last update timestamp |

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

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | VARCHAR(255) | PRIMARY KEY | Unique share link ID |
| `token` | VARCHAR(255) | UNIQUE, NOT NULL | Public share token |
| `user_id` | VARCHAR(255) | NOT NULL, FK → users.id | Creator user ID |
| `expires_at` | TIMESTAMPTZ | | Expiration timestamp (null = no expiration) |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Creation timestamp |

**Indexes:**

- Primary key on `id`
- Unique index on `token`
- Index on `user_id`

**Foreign Keys:**

- `user_id` → `users.id` (ON DELETE CASCADE)

### `share_link_files`

Junction table linking share links to files.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `share_link_id` | VARCHAR(255) | NOT NULL, FK → share_links.id | Share link ID |
| `file_id` | VARCHAR(255) | NOT NULL, FK → files.id | File ID |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Link creation timestamp |

**Indexes:**

- Composite primary key on (`share_link_id`, `file_id`)
- Index on `share_link_id`
- Index on `file_id`

**Foreign Keys:**

- `share_link_id` → `share_links.id` (ON DELETE CASCADE)
- `file_id` → `files.id` (ON DELETE CASCADE)

### `app_settings`

Stores application-wide settings.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Settings identifier (always 'app_settings') |
| `signup_enabled` | BOOLEAN | DEFAULT true | Whether new user registration is enabled |
| `first_user_id` | TEXT | UNIQUE, FK → users.id | Immutable ID of the first user (set once) |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | Last update timestamp |

**Indexes:**

- Primary key on `id`
- Unique index on `first_user_id`

**Foreign Keys:**

- `first_user_id` → `users.id` (ON DELETE RESTRICT) - Prevents deletion of first user

**Notes:**

- Only one row exists in this table (id = 'app_settings')
- `first_user_id` is set when the first user signs up and cannot be changed afterward
- The foreign key constraint with `ON DELETE RESTRICT` prevents deletion of the first user

### `migrations`

Tracks applied database migrations.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `version` | VARCHAR(255) | PRIMARY KEY | Migration version identifier |
| `applied_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Migration application timestamp |

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

## Backup and Maintenance

### Recommended Practices

1. **Regular Backups:**
   - Daily automated backups
   - Point-in-time recovery capability

2. **Index Maintenance:**
   - Periodic `VACUUM ANALYZE` for statistics
   - Reindex if needed

3. **Storage Monitoring:**
   - Monitor table sizes
   - Archive old deleted files
   - Clean up expired share links

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
