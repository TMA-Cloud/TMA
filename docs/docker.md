# Docker Deployment Guide

Guide for deploying TMA Cloud using Docker and Docker Compose.

## Overview

TMA Cloud includes Docker configuration with:

- **Multi-stage Dockerfile** - Builds with minimal image size
- **Docker Compose** - Multi-container orchestration
- **Makefile** - Build commands
- **Dynamic versioning** - Automatic version extraction from `package.json`

## Prerequisites

Before deploying with Docker, ensure you have:

- **Docker** (v20.10 or higher)
- **Docker Compose** (v2.0 or higher)
- **Node.js** (v25 or higher) - Required for extracting version during build
- **PostgreSQL** - Database server (can be containerized or external)

## Quick Start

### 1. Build Docker Image

Using Makefile:

```bash
make build
```

**Note:** The Makefile automatically extracts the version from `backend/package.json` and sets it as an image label.

### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration. See [Environment Variables](environment.md) for detailed information.

### 3. Start Services

Using Docker Compose:

```bash
docker compose up -d
```

This starts three services:

- **App container** (`tma-cloud-app`) - Main application server
- **Worker container** (`tma-cloud-worker`) - Audit event processor
- **Redis container** (`tma-cloud-redis`) - Caching layer (optional but recommended)

Access the application at `http://localhost:3000` (or your configured `BPORT`).

**Note:** Redis is optional but highly recommended. The application will continue to work without Redis, but caching will be disabled and performance will be reduced.

## Docker Files Overview

### Dockerfile

Multi-stage production Dockerfile that:

- **Stage 1**: Builds frontend (React + Vite) with all dependencies
- **Stage 2**: Installs backend production dependencies
- **Stage 3**: Creates final production image with:
  - Non-root user (`nodejs`, UID 1001) for security
  - Health checks for container monitoring
  - Proper signal handling with `dumb-init`
  - Layer caching

**Key Features:**

- Uses `node:X-alpine` base image for minimal size
- Runs as non-root user for security
- Includes health check endpoint
- Dynamic version labeling from `package.json`

### docker-compose.yml

Orchestrates three services:

#### App Service

- Main application server
- Serves both API and frontend static files
- Health check configured
- Volume mount for uploads directory
- Restart policy: `unless-stopped`

#### Worker Service

- **Required** for processing audit events
- Processes events from pg-boss queue
- Writes audit events to database
- Depends on app service
- Restart policy: `unless-stopped`

**Important:** Without the worker, audit events are queued but not written to the database.

#### Redis Service

- **Optional but recommended** for caching layer
- Provides high-performance caching for frequently accessed data
- Persistent storage with AOF (Append Only File) enabled
- Password-protected if `REDIS_PASSWORD` is set in `.env`
- Health check configured
- Data persisted in `redis-data` volume
- Restart policy: `unless-stopped`

**Configuration:**

- Set `REDIS_HOST=redis` in `.env` (container name)
- Set `REDIS_PORT=6379` (default, matches container port)
- Set `REDIS_PASSWORD` in `.env` for production security
- Set `REDIS_DB=0` (default database number)

**Note:** If Redis is unavailable, the application gracefully degrades and continues to work without caching.

### Makefile

Provides build commands:

- `make build` - Build Docker image (extracts version automatically)
- `make build-no-cache` - Build without cache
- `make clean` - Remove Docker image
- `make help` - Show all available commands

**Version Management:**

- Image label `version` is automatically extracted from `backend/package.json`
- `IMAGE_TAG` is separate and can differ from the version label
- Example: `make build IMAGE_TAG=2.0.3` tags image as `tma-cloud:2.0.3` but label version comes from `package.json`

### .dockerignore

Excludes unnecessary files from Docker build context:

- Development files (`.vscode/`, `.idea/`)
- Git files (`.git/`, `.gitignore`)
- Documentation (`docs/`, `*.md`)
- Build artifacts (will be rebuilt in Docker)
- Logs and temporary files

**Note:** `package-lock.json` files are **included** for reproducible builds using `npm ci`.

## Configuration

### Environment Variables

All environment variables are loaded from `.env` file via `env_file` in docker-compose.yml.

**Important Path Configuration:**

When using Docker, ensure `UPLOAD_DIR` in `.env` matches the container path:

- If using default volume mount (`./uploads:/app/uploads`), set: `UPLOAD_DIR=/app/uploads`
- If mounting custom path (`/my_path/uploads:/my_path/uploads`), set: `UPLOAD_DIR=/my_path/uploads`

The path in `.env` must be the **container path**, not the host path.

**Redis Configuration:**

When using Docker Compose with the included Redis service:

- Set `REDIS_HOST=redis` (container name)
- Set `REDIS_PORT=6379` (default, matches container port)
- Set `REDIS_PASSWORD` in `.env` for production security (optional but recommended)
- Set `REDIS_DB=0` (default database number)

If using an external Redis server:

- Set `REDIS_HOST` to your Redis server hostname or IP
- Set `REDIS_PORT` to your Redis server port
- Set `REDIS_PASSWORD` if your Redis server requires authentication
- Set `REDIS_DB` to your preferred database number

**Note:** The application gracefully degrades if Redis is unavailable, but caching will be disabled.

### Volume Mounts

Default configuration mounts `./uploads` to `/app/uploads`:

```yaml
volumes:
  - ./uploads:/app/uploads
```

**Permissions:**

Ensure the host uploads directory has correct permissions:

```bash
mkdir -p uploads
chown -R 1001:1001 uploads  # Container runs as UID 1001
# Or for quick testing:
chmod -R 777 uploads
```

### Port Configuration

Port mapping uses `BPORT` from `.env`:

```yaml
ports:
  - "${BPORT:-3000}:3000"
```

Default is `3000:3000` if `BPORT` is not set.

### Custom Drive with Docker

When using Custom Drive mode with Docker, you need to mount host directories into the container.

**Setup Steps:**

Custom drive is configured per-user in the Settings page. To mount host directories for users to use:

1. Add `CUSTOM_DRIVE_MOUNT_1`, `CUSTOM_DRIVE_MOUNT_2`, etc. to your `.env` file (add more as needed):

   ```bash
   # Format: CUSTOM_DRIVE_MOUNT_N=/host/path:/container/path (REQUIRED - must include colon)
   # Linux example:
   CUSTOM_DRIVE_MOUNT_1=/mnt/nas_drive:/data/custom_drive
   CUSTOM_DRIVE_MOUNT_2=/mnt/data_col:/data_col
   CUSTOM_DRIVE_MOUNT_3=/mnt/backup:/data/backup
   
   # Windows example (use forward slashes):
   CUSTOM_DRIVE_MOUNT_1=C:/Users/username/my_drive:/data/custom_drive
   CUSTOM_DRIVE_MOUNT_2=C:/Users/username/data_col:/data_col
   ```

2. Uncomment/add corresponding mount lines in `docker-compose.yml` if you add more than 2 mounts (default shows 2, but you can add more).

3. Administrators can then configure users' custom drive in Settings:
   - Navigate to Settings page (admin access required)
   - Go to "Custom Drive Management" section
   - For each user, enable "Use Custom Drive" toggle
   - Set path to the container path (e.g., `/data/custom_drive` or `/data_col`)
   - Click "Save" to apply changes

**How It Works:**

- `CUSTOM_DRIVE_MOUNT_N` = Host path and container path separated by colon (host:container)
- Docker Compose mounts the host path to the container path
- Administrators configure each user's custom drive path in Settings (must match a mounted container path)
- Backend validates paths and rejects placeholder paths
- Only administrators can manage custom drive settings

**Example Configuration:**

```bash
# .env for Linux with multiple mounts
CUSTOM_DRIVE_MOUNT_1=/mnt/nas/cloud_storage:/data/custom_drive
CUSTOM_DRIVE_MOUNT_2=/mnt/backup:/data/backup
CUSTOM_DRIVE_MOUNT_3=/mnt/archive:/data/archive

# .env for Windows
CUSTOM_DRIVE_MOUNT_1=D:/CloudDrive:/data/custom_drive
CUSTOM_DRIVE_MOUNT_2=E:/Storage:/data/storage
```

**Important Notes:**

- **Format is REQUIRED**: Must include colon separator (host:container)
- Custom drive is configured per-user by administrators in the Settings page (not via environment variables)
- Only administrators can manage custom drive settings for users
- When a user has custom drive enabled, `UPLOAD_DIR`, `STORAGE_LIMIT`, and `STORAGE_PATH` are ignored for that user
- Files are uploaded directly to the user's custom drive path
- Storage dashboard shows actual disk space of the user's custom drive
- Files are stored with original filenames in the user's custom drive directory
- **Backend will NOT create directories** - paths must already exist as mounted volumes
- Backend validates paths exist and are accessible, and rejects placeholder paths

**Permissions:**

Ensure the host directories have correct permissions:

```bash
# Create directory if needed
mkdir -p /mnt/nas_drive

# Set ownership to container user (UID 1001)
chown -R 1001:1001 /mnt/nas_drive

# Or for quick testing:
chmod -R 755 /mnt/nas_drive
```

### Network Configuration

Both services use the `tma-cloud-network` bridge network for communication.

## Building Images

### Using Makefile (Recommended)

```bash
# Build with default tag (latest)
make build

# Build with custom tag
make build IMAGE_TAG=2.0.3

# Build without cache
make build-no-cache

# View help
make help
```

### Using Docker Directly

```bash
# Extract version manually
VERSION=$(node -p "require('./backend/package.json').version")

# Build with version
docker build --build-arg VERSION=$VERSION -t tma-cloud:latest .

# Build without version (will be empty in labels)
docker build -t tma-cloud:latest .
```

## Running Containers

### Using Docker Compose (Recommended)

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

## Monitoring & Health Checks

### Health Check

Check health status:

```bash
docker inspect --format='{{.State.Health.Status}}' tma-cloud-app
```

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f app
docker compose logs -f worker

# Last 100 lines
docker compose logs --tail=100 app
```

### Container Stats

```bash
docker stats tma-cloud-app tma-cloud-worker
```

## Related Documentation

- [Setup Guide](setup.md) - Manual installation without Docker
- [Environment Variables](environment.md) - Complete environment variable reference
- [Architecture Overview](architecture.md) - System architecture details
- [Audit Trail](audit.md) - Audit worker configuration and monitoring
