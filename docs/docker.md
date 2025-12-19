# Docker Deployment Guide

Complete guide for deploying TMA Cloud using Docker and Docker Compose.

## Overview

TMA Cloud includes production-ready Docker configuration with:

- **Multi-stage Dockerfile** - Optimized builds with minimal image size
- **Docker Compose** - Easy multi-container orchestration
- **Makefile** - Convenient build commands
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

This starts both:

- **App container** (`tma-cloud-app`) - Main application server
- **Worker container** (`tma-cloud-worker`) - Audit event processor

Access the application at `http://localhost:3000` (or your configured `BPORT`).

## Docker Files Overview

### Dockerfile

Multi-stage production Dockerfile that:

- **Stage 1**: Builds frontend (React + Vite) with all dependencies
- **Stage 2**: Installs backend production dependencies
- **Stage 3**: Creates final production image with:
  - Non-root user (`nodejs`, UID 1001) for security
  - Health checks for container monitoring
  - Proper signal handling with `dumb-init`
  - Optimized layer caching

**Key Features:**

- Uses `node:X-alpine` base image for minimal size
- Runs as non-root user for security
- Includes health check endpoint
- Dynamic version labeling from `package.json`

### docker-compose.yml

Orchestrates two services:

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

### Makefile

Provides convenient build commands:

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
