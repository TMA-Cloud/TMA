# Docker Deployment

Docker deployment guide for TMA Cloud.

## Prerequisites

- Docker (v20.10+)
- Docker Compose (v2.0+)
- Node.js (v25+) - For version extraction during build

## Quick Start

### 1. Build Docker Image

```bash
make build
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

### 3. Start Services

```bash
docker compose up -d
```

Starts three services:

- **App** (`tma-cloud-app`) - Main application
- **Worker** (`tma-cloud-worker`) - Audit event processor (required)
- **Redis** (`tma-cloud-redis`) - Caching layer (optional but recommended)

Access at `http://localhost:3000` (or configured `BPORT`).

## Configuration

### Environment Variables

All variables loaded from `.env` file.

**Important:** `UPLOAD_DIR` in `.env` must match container path:

- Default: `UPLOAD_DIR=/app/uploads` (matches `./uploads:/app/uploads` volume)
- Custom: Match your volume mount path

**Redis Configuration:**

- `REDIS_HOST=redis` (container name)
- `REDIS_PORT=6379`
- `REDIS_PASSWORD` (optional, recommended for production)

### Volume Mounts

Default: `./uploads:/app/uploads`

**Permissions:**

```bash
mkdir -p uploads
chown -R 1001:1001 uploads  # Container runs as UID 1001
```

### Custom Drive with Docker

1. Add `CUSTOM_DRIVE_MOUNT_N` to `.env`:

   ```bash
   CUSTOM_DRIVE_MOUNT_1=/host/path:/container/path
   CUSTOM_DRIVE_MOUNT_2=/mnt/data:/data/storage
   ```

2. Uncomment/add mount lines in `docker-compose.yml` if needed.

3. Configure per-user in Settings page (admin-only).

**Format:** `/host/path:/container/path` (must include colon)

**Permissions:**

```bash
chown -R 1001:1001 /host/path
```

## Building Images

```bash
# Build with default tag
make build

# Build with custom tag
make build IMAGE_TAG=2.0.3

# Build without cache
make build-no-cache
```

## Running Containers

```bash
# Start in background
docker compose up -d

# Stop services
docker compose down

# Stop and remove volumes
docker compose down -v

# Restart services
docker compose restart
```

## Monitoring

**Health Check:**

```bash
docker inspect --format='{{.State.Health.Status}}' tma-cloud-app
```

**View Logs:**

```bash
docker compose logs -f
docker compose logs -f app
docker compose logs -f worker
```

**Container Stats:**

```bash
docker stats tma-cloud-app tma-cloud-worker
```
