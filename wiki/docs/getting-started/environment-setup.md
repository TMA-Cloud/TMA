# Environment Setup

Environment variable reference for TMA Cloud.

## Application Configuration

| Variable      | Required         | Default       | Description         |
| ------------- | ---------------- | ------------- | ------------------- |
| `NODE_ENV`    | No               | `development` | Environment mode    |
| `BPORT`       | No               | `3000`        | Backend server port |
| `BACKEND_URL` | Yes (OnlyOffice) | -             | Public backend URL  |

## Database Configuration

| Variable      | Required | Default             | Description       |
| ------------- | -------- | ------------------- | ----------------- |
| `DB_HOST`     | No       | `localhost`         | PostgreSQL host   |
| `DB_PORT`     | No       | `5432`              | PostgreSQL port   |
| `DB_USER`     | No       | `postgres`          | Database username |
| `DB_PASSWORD` | Yes      | -                   | Database password |
| `DB_NAME`     | No       | `tma_cloud_storage` | Database name     |
| `DB_SSLMODE`  | No       | `disable`           | SSL mode          |

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

| Variable              | Required | Default     | Description                    |
| --------------------- | -------- | ----------- | ------------------------------ |
| `STORAGE_DRIVER`      | No       | `local`     | `local` or `s3`                |
| `UPLOAD_DIR`          | No       | `./uploads` | Upload directory (local only)  |
| `FILE_ENCRYPTION_KEY` | No       | -           | Encryption key (see reference) |

**Note:** Storage limits are configured per-user in Settings (admin only). For S3-compatible storage, see [Environment Variables](/reference/environment-variables).

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

## Frontend Environment Variables

**No frontend environment variables required!**

Single-Origin Architecture means frontend uses relative URLs and is served from the same origin as the backend.

## Next Steps

- [First Login](first-login.md) - Create your first account
- [Reference: Environment Variables](/reference/environment-variables) - Complete reference
