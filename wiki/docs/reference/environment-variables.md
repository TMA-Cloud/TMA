# Environment Variables

Complete reference for all environment variables in TMA Cloud.

## Application Configuration

| Variable      | Required         | Default       | Description         |
| ------------- | ---------------- | ------------- | ------------------- |
| `NODE_ENV`    | No               | `development` | Environment mode    |
| `BPORT`       | No               | `3000`        | Backend server port |
| `BACKEND_URL` | Yes (OnlyOffice) | -             | Public backend URL  |

## Database Configuration

| Variable      | Required | Default         | Description       |
| ------------- | -------- | --------------- | ----------------- |
| `DB_HOST`     | No       | `localhost`     | PostgreSQL host   |
| `DB_PORT`     | No       | `5432`          | PostgreSQL port   |
| `DB_USER`     | No       | `postgres`      | Database username |
| `DB_PASSWORD` | Yes      | -               | Database password |
| `DB_NAME`     | No       | `cloud_storage` | Database name     |
| `DB_SSLMODE`  | No       | `disable`       | SSL mode          |

## Redis Configuration

| Variable         | Required | Default     | Description                  |
| ---------------- | -------- | ----------- | ---------------------------- |
| `REDIS_HOST`     | No       | `localhost` | Redis host                   |
| `REDIS_PORT`     | No       | `6379`      | Redis port                   |
| `REDIS_PASSWORD` | No       | -           | Redis password (recommended) |
| `REDIS_DB`       | No       | `0`         | Redis database number        |

**Note:** Redis is optional. App works without it but caching is disabled.

## Authentication

| Variable          | Required | Default | Description                                  |
| ----------------- | -------- | ------- | -------------------------------------------- |
| `JWT_SECRET`      | Yes      | -       | Secret key for JWT tokens                    |
| `SESSION_BINDING` | No       | `true`  | Enable session binding (browser fingerprint) |

## Google OAuth (Optional)

| Variable               | Required | Description                              |
| ---------------------- | -------- | ---------------------------------------- |
| `GOOGLE_CLIENT_ID`     | No       | Google OAuth Client ID                   |
| `GOOGLE_CLIENT_SECRET` | No       | Google OAuth Client Secret               |
| `GOOGLE_REDIRECT_URI`  | No       | Redirect URI (must match Google Console) |

**Note:** All three must be set to enable Google OAuth.

## File Storage

| Variable              | Required | Default             | Description                        |
| --------------------- | -------- | ------------------- | ---------------------------------- |
| `STORAGE_DRIVER`      | No       | `local`             | `local` or `s3`                    |
| `UPLOAD_DIR`          | No       | `./uploads`         | Upload directory (local only)      |
| `FILE_ENCRYPTION_KEY` | No       | Development default | Encryption key for file encryption |

**Note:** All file operations use streaming for large files. No memory limits for file size.

## S3-compatible (when STORAGE_DRIVER=s3)

| Setting    | Required | Default     | Env var (either name)                              |
| ---------- | -------- | ----------- | -------------------------------------------------- |
| Endpoint   | Yes\*    | -           | `RUSTFS_ENDPOINT` or `AWS_S3_ENDPOINT`             |
| Bucket     | Yes\*    | -           | `RUSTFS_BUCKET` or `AWS_S3_BUCKET`                 |
| Access key | Yes\*    | -           | `RUSTFS_ACCESS_KEY` or `AWS_ACCESS_KEY_ID`         |
| Secret key | Yes\*    | -           | `RUSTFS_SECRET_KEY` or `AWS_SECRET_ACCESS_KEY`     |
| Region     | No       | `us-east-1` | `RUSTFS_REGION` or `AWS_REGION`                    |
| Path style | No       | `true`      | `RUSTFS_FORCE_PATH_STYLE` (set `false` to disable) |

\*Required when `STORAGE_DRIVER=s3`. Use one set of names consistently (e.g. all AWS*\* or all RUSTFS*\*).

**Note:** Abort incomplete multipart uploads after 1 day: from backend run `npm run s3:lifecycle`. Run orphan cleanup frequently; see [Storage Management](/concepts/storage-management).

## Logging Configuration

| Variable              | Required | Default                       | Description                                        |
| --------------------- | -------- | ----------------------------- | -------------------------------------------------- |
| `LOG_LEVEL`           | No       | `info` (prod), `debug` (dev)  | Log level (fatal, error, warn, info, debug, trace) |
| `LOG_FORMAT`          | No       | `json` (prod), `pretty` (dev) | Log format (json, pretty)                          |
| `METRICS_ALLOWED_IPS` | No       | `127.0.0.1,::1`               | IPs allowed to access `/metrics`                   |

## Audit Logging Configuration

| Variable                   | Required | Default       | Description                       |
| -------------------------- | -------- | ------------- | --------------------------------- |
| `AUDIT_WORKER_CONCURRENCY` | No       | `5`           | Concurrent audit events processed |
| `AUDIT_JOB_TTL_SECONDS`    | No       | `82800` (23h) | Job TTL (must be < 24h)           |

## Related Topics

- [Environment Setup](/getting-started/environment-setup) - Setup guide
- [Docker Setup](/getting-started/docker) - Docker configuration
