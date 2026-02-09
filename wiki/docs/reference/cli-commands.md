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

### Bulk import drive to S3

When you have existing data on a local drive (e.g. 100GB+) and want it in the app’s S3 bucket **with** encryption and DB records (so the app and DB stay in sync), use the bulk import script. Copying files directly into the bucket would skip encryption and the `files` table, causing mismatch and `FILE_ENCRYPTION_KEY` issues.

From the **backend** directory, with `.env` set (S3 + `FILE_ENCRYPTION_KEY`):

```bash
# Dry run: only list folders/files and total size
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID --dry-run

# Import (creates folder hierarchy in DB, encrypts and uploads each file)
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID

# Use email instead of user ID
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-email "you@example.com"

# Optional: more concurrent uploads (default 2)
node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-id YOUR_USER_ID --concurrency 4

```

- Preserves folder structure and file names; invalid names are skipped with a warning.
- Always enforces per-user storage limit and max file size (checked before any upload).
- Preserves file and folder modification times (mtime).

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

## Related Topics

- [Installation](/getting-started/installation) - Setup guide
- [Docker Compose / Docker](/getting-started/docker) - Docker Compose and prebuilt images
