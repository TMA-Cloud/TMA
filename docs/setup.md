# Setup & Installation Guide

This guide will walk you through setting up TMA Cloud on your local machine or server.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v25 or higher)
- **PostgreSQL** (v17 or higher)
- **Redis** (v6 or higher) - Required for caching
- **npm** or **yarn** package manager

**Note:** For Docker deployment, see [Docker Deployment Guide](docker.md) instead.

## Installation Steps

### 1. Clone the Repository

```bash
git clone https://github.com/TMA-Cloud/TMA.git
cd TMA
```

### 2. Backend Setup

#### Install Backend Dependencies

```bash
cd backend
npm install
```

#### Configure Backend Environment Variables

Copy the example environment file in the root directory:

```bash
# Copy .env.example to .env in root directory
cp ../.env.example ../.env
```

Edit `.env` in the root directory with your configuration. See [Environment Variables](environment.md) for detailed information about each variable.

**Required variables:**

- `JWT_SECRET` - Secret key for JWT tokens
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` - Database connection details
- `REDIS_HOST`, `REDIS_PORT` - Redis connection details (password optional but recommended)
- `BPORT` - Backend server port (default: 3000)
- `UPLOAD_DIR` - Directory to store uploaded files

**Optional variables:**

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` - For Google OAuth
- `BACKEND_URL` - Public backend URL (required for OnlyOffice integration, see [Environment Variables](environment.md#backend-url))
- `CUSTOM_DRIVE_MOUNT_N` - Optional Docker mounts for custom drive (format: /host/path:/container/path, supports multiple mounts, administrators configure per-user in Settings)
- `STORAGE_LIMIT` - Per-user storage limit in bytes

#### Create Database

Create a PostgreSQL database:

```sql
CREATE DATABASE cloud_storage;
```

The application will automatically run migrations on startup to create the necessary tables.

#### Setup Redis

Install and start Redis server:

**Linux/macOS:**

```bash
# Install Redis (varies by distribution)
# Ubuntu/Debian:
sudo apt-get install redis-server

# macOS (Homebrew):
brew install redis
brew services start redis

# Start Redis
redis-server
```

**Windows:**

- Download Redis from [Redis for Windows](https://github.com/microsoftarchive/redis/releases) or use WSL
- Or use Docker: `docker run -d -p 6379:6379 redis:alpine`

**Verify Redis is running:**

```bash
redis-cli ping
# Should return: PONG
```

**Note:** Redis is optional but highly recommended. The application will continue to work without Redis, but caching will be disabled and performance will be reduced.

### 3. Frontend Setup

#### Install Frontend Dependencies

```bash
cd ../frontend
npm install
```

#### Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory and will be served by the backend.

**Note:** No frontend environment variables are needed! The frontend uses relative URLs and is served from the same origin as the backend (Single-Origin Architecture).

### 4. Start the Application

#### Production Mode (Recommended)

**Terminal 1 - Backend Server:**

```bash
cd ../backend
npm start
```

**Terminal 2 - Audit Worker (Required for Production):**

```bash
cd backend
npm run worker
```

**Important:** The audit worker must be running in production to process audit events. Without it, audit events will be queued but not written to the database.

Access the application at `http://localhost:3000` (or your configured BPORT).

The backend serves both:

- Frontend static files at `/`
- API endpoints at `/api/*` and `/s/*`

#### Development Mode (with Hot Reload)

For active development with frontend hot module replacement:

**Terminal 1 - Backend:**

```bash
cd backend
npm run dev
```

**Terminal 2 - Frontend Dev Server:**

```bash
cd frontend
npm run dev
```

Access at `http://localhost:5173`

The Vite dev server automatically proxies API requests to `http://localhost:3000`.

## Verification

### 1. Backend Health Check

When you start the backend, you should see:

- ✅ "Database connected successfully"
- ✅ "Database query test successful"
- ✅ "Server running on port 3000"

### 2. Frontend Access

Open your browser and navigate to:

- **Production**: `http://localhost:3000`
- **Development**: `http://localhost:5173`

You should see the login/signup page.

### 3. Create First Account

Sign up with a new account to test the system. The first user automatically becomes the admin and can control signup settings.

### 4. Verify Audit Worker (Production)

If running in production mode, verify the audit worker is processing events:

- Check worker logs for "Audit worker started" message
- Perform an action (e.g., upload a file) and verify audit events are logged
- See [Audit Documentation](audit.md) for monitoring and troubleshooting

## Troubleshooting

### Database Connection Issues

- Verify PostgreSQL is running: `pg_isready`
- Check database credentials in root `.env`
- Ensure the database exists: `psql -l`
- Verify the database user has CREATE TABLE permissions

### Redis Connection Issues

- Verify Redis is running: `redis-cli ping` (should return `PONG`)
- Check Redis connection details in root `.env` (`REDIS_HOST`, `REDIS_PORT`)
- If using password, verify `REDIS_PASSWORD` is correct
- Check Redis logs for connection errors
- **Note:** Application will continue to work without Redis, but caching will be disabled

### Port Already in Use

- Change `BPORT` in root `.env` to use a different port
- In development, Vite will automatically use the next available port after 5173

### Migration Errors

- Ensure the database user has CREATE TABLE permissions
- Check that the `migrations` table was created successfully
- Review migration files in `backend/migrations/` for SQL errors
- Check backend console for specific error messages

### Frontend Build Errors

- Ensure all dependencies are installed: `npm install`
- Clear the build cache: `rm -rf dist node_modules/.vite`
- Reinstall dependencies: `npm install`
- Try building again: `npm run build`

### Google OAuth Issues

- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct
- Ensure `GOOGLE_REDIRECT_URI` is set to `http://YOUR_DOMAIN/api/google/callback`
- Check that the redirect URI matches exactly in Google Cloud Console
- Ensure your domain is authorized in Google Cloud Console

### OnlyOffice Integration Issues

- **Configuration**: OnlyOffice settings are configured via the Settings page (admin-only), not environment variables
  - Navigate to Settings → OnlyOffice Integration
  - Enter your OnlyOffice Document Server URL and JWT Secret
  - Both fields must be provided together (or both cleared)
- **Document Server**: Verify your OnlyOffice Document Server is running and accessible
- **JWT Secret**: Ensure the JWT Secret matches your Document Server configuration
- **Backend URL**: Verify `BACKEND_URL` environment variable is set to the public URL of your backend (see [Environment Variables](environment.md#backend-url))
- **Network**: Check that the Document Server can reach your backend via `BACKEND_URL`
- **Firewall**: Verify firewall rules allow communication between servers
- **CSP Headers**: CSP headers are automatically updated when settings are saved (uses in-memory cache for performance)

### Audit Worker Issues

- Ensure the audit worker is running: `npm run worker`
- Check that `AUDIT_WORKER_CONCURRENCY` is set appropriately (default: 5)
- Verify database connection in worker logs
- Check pg-boss queue status (see [Audit Documentation](audit.md) for query examples)
- Ensure PostgreSQL has sufficient connections for both backend and worker

## Next Steps

- Read the [Architecture Overview](architecture.md) to understand the system design
- Check [API Documentation](api.md) for available endpoints
- Review [Features](features.md) to learn about available functionality
- Configure [Environment Variables](environment.md) for your deployment
- **Important:** Ensure the [Audit Worker](audit.md#starting-the-audit-worker) is running in production
- Review [Logging System](logging.md) for monitoring and debugging
- For Docker deployment, see [Docker Deployment Guide](docker.md)
