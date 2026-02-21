# CLI Commands

Command-line interface commands for TMA Cloud.

## Backend Commands

### Start Application

```bash
npm start
```

Start the main application server.

### Development Mode

```bash
npm run dev
```

Start application in development mode with hot reload.

### Audit Worker

```bash
npm run worker
```

Start the audit event processing worker (required in production).

### Development Worker

```bash
npm run dev:worker
```

Start audit worker in development mode with hot reload.

### Linting

```bash
npm run lint
```

Run ESLint to check code quality.

```bash
npm run lint:fix
```

Run ESLint and automatically fix issues.

### Formatting

```bash
npm run format
```

Format code with Prettier.

```bash
npm run format:check
```

Check code formatting without making changes.

### S3 bucket (when STORAGE_DRIVER=s3)

Run from backend directory. Uses project S3 config (RUSTFS*\* or AWS*\* env vars).

```bash
npm run s3:protect-all
```

Apply all bucket protections: block public access; bucket policy (HTTPS only); versioning; default SSE if supported; lifecycle (abort incomplete multipart + delete old versions and delete markers).

```bash
npm run s3:lifecycle
```

Apply lifecycle rules only: abort incomplete multipart uploads after 1 day; delete noncurrent versions after 7 days; remove expired delete markers.

```bash
npm run s3:policy-https
```

Apply bucket policy that denies HTTP (HTTPS only).

```bash
npm run s3:public-block
```

Block public access (private bucket).

```bash
npm run s3:versioning
```

Enable versioning on the bucket.

```bash
npm run s3:encryption
```

Enable default server-side encryption (AES256). Not supported by all S3-compatible stores; script exits with error if unsupported.

To check current lifecycle config from project root: `node backend/scripts/check-s3-lifecycle.js`.

### Bulk import (drive to storage)

**Requirement:** the database must be reachable from the host. If the app runs in Docker, uncomment the postgres `ports` in `docker-compose.yml` (e.g. `127.0.0.1:5432:5432`) so the host can connect.

#### Bulk import drive to local

Use when you have existing data on disk and want it in the app's **local** storage with encryption and DB records. Requires `STORAGE_DRIVER=local`, `LOCAL_STORAGE_PATH`, and `FILE_ENCRYPTION_KEY` in `.env`.

From the **backend** directory:

```bash
# Dry run: list folders/files and total size only
node scripts/bulk-import-drive-to-local.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID --dry-run

# Import (creates folder hierarchy in DB, encrypts and copies each file)
node scripts/bulk-import-drive-to-local.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID

# Use email instead of user ID
node scripts/bulk-import-drive-to-local.js --source-dir "D:\MyDrive" --user-email "you@example.com"

# Optional: more concurrent copies (default 2)
node scripts/bulk-import-drive-to-local.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID --concurrency 4
```

- Preserves folder structure; invalid file names are sanitized with a warning.
- Enforces per-user storage limit and max file size (checked before any copy).
- Preserves file and folder modification times (mtime).

#### Bulk import drive to S3

Use when you have existing data on disk and want it in the app's S3 bucket with encryption and DB records. Copying files directly into the bucket would skip encryption and the `files` table. Requires S3 env vars and `FILE_ENCRYPTION_KEY` in `.env`.

From the **backend** directory:

```bash
# Dry run: list folders/files and total size only
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID --dry-run

# Import (creates folder hierarchy in DB, encrypts and uploads each file)
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID

# Use email instead of user ID
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-email "you@example.com"

# Optional: more concurrent uploads (default 2)
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID --concurrency 4

```

- Preserves folder structure; invalid file names are sanitized with a warning.
- Enforces per-user storage limit and max file size (checked before any upload).
- Preserves file and folder modification times (mtime). On first error, S3 script rolls back created folders and uploaded files.

## Docker Commands

### Using Prebuilt Images (Recommended)

Prebuilt Docker images are available on GitHub Container Registry:

```bash
docker pull ghcr.io/tma-cloud/tma:latest
docker pull ghcr.io/tma-cloud/tma:2.0.4
```

### Build Image from Source

```bash
make build
```

Build Docker image with default tag.

```bash
make build IMAGE_TAG=2.0.4
```

Build Docker image with custom tag.

```bash
make build-no-cache
```

Build Docker image without cache.

### Docker Compose

```bash
docker compose up -d
```

Start all services in background.

```bash
docker compose down
```

Stop all services.

```bash
docker compose restart
```

Restart all services.

```bash
docker compose logs -f
```

View logs from all services.

```bash
docker compose logs -f app
```

View logs from app service only.

## Database Commands

### PostgreSQL

```bash
psql -h localhost -U postgres -d cloud_storage
```

Connect to PostgreSQL database.

### Migrations

Migrations run automatically on application startup.

### Backup & Restore

```bash
./scripts/db-backup-restore.sh backup
```

Full database backup. Outputs a compressed `.dump` file with a `.meta` sidecar (SHA-256 checksum, table row counts, backup metadata).

```bash
./scripts/db-backup-restore.sh restore backups/<file>.dump
```

Restore database from a backup. Validates integrity before touching the database, restores in single-transaction mode.

```bash
./scripts/db-backup-restore.sh verify backups/<file>.dump
```

Verify a backup file's SHA-256 checksum and dump TOC without restoring.

```bash
./scripts/db-backup-restore.sh list
```

List available backups with file sizes and dates.

The script auto-detects the PostgreSQL Docker container. Override with `DB_CONTAINER` env var. See [Backups](/guides/operations/backups) for details.

## Related Topics

- [Installation](/getting-started/installation) - Setup guide
- [Docker Compose / Docker](/getting-started/docker) - Docker Compose and prebuilt images
