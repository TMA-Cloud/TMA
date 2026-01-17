# Environment Variables

Complete reference for all environment variables in TMA Cloud.

## Application Configuration

| Variable         | Required         | Default        | Description              |
| ---------------- | ---------------- | -------------- | ------------------------ |
| `NODE_ENV`       | No               | `development`  | Environment mode         |
| `BPORT`          | No               | `3000`         | Backend server port      |
| `BACKEND_URL`    | Yes (OnlyOffice) | -              | Public backend URL       |
| `SHARE_BASE_URL` | No               | Request origin | Base URL for share links |

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
| `UPLOAD_DIR`          | No       | `./uploads`         | Upload directory path              |
| `FILE_ENCRYPTION_KEY` | No       | Development default | Encryption key for file encryption |

**Note:** All file operations use streaming for large files. No memory limits for file size.

## Custom Drive Agent (Docker Only)

| Variable              | Required | Description                                          |
| --------------------- | -------- | ---------------------------------------------------- |
| `AGENT_WEBHOOK_TOKEN` | No       | Token for agent webhook authentication (recommended) |

**Note:** Custom drive paths are configured per-user in Settings → Users (admin-only).

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
