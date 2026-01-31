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

```bash
npm run s3:lifecycle
```

Apply bucket lifecycle rule: abort incomplete multipart uploads after 1 day. Uses project S3 config; only targets incomplete uploads. Run from backend directory.

To check current lifecycle config from project root: `node backend/scripts/check-s3-lifecycle.js`.

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
