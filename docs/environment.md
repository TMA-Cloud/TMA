# Environment Variables

Complete reference for all environment variables used in TMA Cloud.

## Backend Environment Variables

Create a `.env` file in the **root directory** of the project with the following variables.

### Application Configuration

#### `NODE_ENV`

- **Type:** String
- **Required:** No
- **Default:** `development`
- **Description:** Environment mode (development, production, test)
- **Example:** `NODE_ENV=production`

#### `BPORT`

- **Type:** Number
- **Required:** No
- **Default:** `3000`
- **Description:** Port number for the backend server
- **Example:** `BPORT=3000`

#### `BACKEND_URL`

- **Type:** String (URL)
- **Required:** Yes (for OnlyOffice integration)
- **Description:** Public URL of the backend server that OnlyOffice can access
- **Example:** `BACKEND_URL=https://api.example.com`

#### `SHARE_BASE_URL`

- **Type:** String (URL)
- **Required:** No
- **Default:** Request origin derived from proxy-aware headers (`X-Forwarded-Proto` / `X-Forwarded-Host`) or the incoming request host
- **Description:** Optional base URL used when generating public share links. Set this if want share links to use a dedicated domain or CDN entry point instead of the main app domain. This isolates share link traffic from main application.
- **Example:** `SHARE_BASE_URL=https://share.example.com`
- **Behavior:**
  - If not set, share links will use the request origin (from proxy headers or request host)
  - If set, all share links will use this configured domain instead
  - Falls back to `http://localhost` only in the rare case where no origin can be determined (no host header and no proxy headers)
- **Security:**
  - When configured, the share domain is locked down to only serve `/s/*` routes (share links)
  - All other routes (main app, API, static files) return 404 on the share domain
  - See [Features - Custom Share Domain](features.md#custom-share-domain) for complete details

---

### Database Configuration

#### `DB_HOST`

- **Type:** String
- **Required:** No
- **Default:** `localhost`
- **Description:** PostgreSQL database host
- **Example:** `DB_HOST=localhost`

#### `DB_PORT`

- **Type:** Number
- **Required:** No
- **Default:** `5432`
- **Description:** PostgreSQL database port
- **Example:** `DB_PORT=5432`

#### `DB_USER`

- **Type:** String
- **Required:** No
- **Default:** `postgres`
- **Description:** PostgreSQL database username
- **Example:** `DB_USER=postgres`

#### `DB_PASSWORD`

- **Type:** String
- **Required:** Yes
- **Description:** PostgreSQL database password
- **Example:** `DB_PASSWORD=your_secure_password`

#### `DB_NAME`

- **Type:** String
- **Required:** No
- **Default:** `cloud_storage`
- **Description:** PostgreSQL database name
- **Example:** `DB_NAME=cloud_storage`

#### `DB_SSLMODE`

- **Type:** String
- **Required:** No
- **Default:** `disable`
- **Description:** SSL mode for database connection (`disable`, `require`, `prefer`)
- **Example:** `DB_SSLMODE=require`

---

### Redis Configuration

Redis is used for caching frequently accessed data to improve performance and reduce database load.

#### `REDIS_HOST`

- **Type:** String
- **Required:** No
- **Default:** `localhost`
- **Description:** Redis server host address
- **Example:** `REDIS_HOST=localhost`
- **Docker Example:** `REDIS_HOST=redis` (use container name when using docker-compose)
- **Production Example:** `REDIS_HOST=redis.example.com`

#### `REDIS_PORT`

- **Type:** Number
- **Required:** No
- **Default:** `6379`
- **Description:** Redis server port number
- **Example:** `REDIS_PORT=6379`

#### `REDIS_PASSWORD`

- **Type:** String
- **Required:** No (recommended for production)
- **Description:** Redis server password for authentication
- **Example:** `REDIS_PASSWORD=your_secure_redis_password`
- **Security Note:** Always set a strong password in production environments
- **Docker:** If set, Redis container will require this password

#### `REDIS_DB`

- **Type:** Number
- **Required:** No
- **Default:** `0`
- **Description:** Redis database number (0-15)
- **Example:** `REDIS_DB=0`
- **Note:** Use different database numbers to separate environments (e.g., 0 for production, 1 for staging)

**What Gets Cached:**

- File listings and metadata
- Search results (with hashed queries for security)
- User data (passwords never cached, emails hashed in keys)
- Share link information
- Session validation
- File statistics and folder sizes
- Custom drive settings

**Cache Behavior:**

- Automatic cache invalidation on data mutations
- Configurable TTLs based on data volatility (1-10 minutes)
- Graceful degradation if Redis is unavailable
- Non-blocking SCAN operations for pattern deletion
- Privacy-focused: emails hashed, passwords never cached

**Security Features:**

- Email addresses hashed in cache keys (GDPR compliance)
- Search queries hashed to prevent cache key injection
- User data properly isolated by user ID
- No sensitive data (passwords, plaintext emails) in cache

---

### Authentication

#### `JWT_SECRET`

- **Type:** String
- **Required:** Yes
- **Description:** Secret key for signing JWT tokens. Use a strong, random string.
- **Example:** `JWT_SECRET=your_super_secret_jwt_key_here`
- **Security:** Generate a strong random string (at least 32 characters)

#### `SESSION_BINDING`

- **Type:** String
- **Required:** No
- **Default:** `true`
- **Values:** `true` or `false`
- **Description:** Enable session binding to prevent token theft. When enabled, tokens are bound to the user's browser fingerprint (User-Agent hash). If a token is used from a different browser, the request is blocked and logged as suspicious.
- **Example:** `SESSION_BINDING=true`
- **When to Disable:**
  - Users frequently switch browsers or devices
  - Users access the app from multiple User-Agent strings (e.g., browser extensions modifying headers)
  - Development/testing environments
- **Security:**
  - When enabled, stolen tokens cannot be used from different browsers
  - Suspicious token usage is logged as `auth.suspicious_token` audit events
  - Provides protection against session hijacking without affecting legitimate users
- **See:** [Features - Session Security](features.md#session-security) for complete details

---

### Google OAuth 2.0 (Optional)

#### `GOOGLE_CLIENT_ID`

- **Type:** String
- **Required:** No (required if enabling Google OAuth)
- **Description:** Google OAuth 2.0 Client ID
- **Example:** `GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com`
- **How to get:** [Google Cloud Console](https://console.cloud.google.com/)

#### `GOOGLE_CLIENT_SECRET`

- **Type:** String
- **Required:** No (required if enabling Google OAuth)
- **Description:** Google OAuth 2.0 Client Secret
- **Example:** `GOOGLE_CLIENT_SECRET=GOCSPX-abc123def456`
- **Security:** Keep this secret secure

#### `GOOGLE_REDIRECT_URI`

- **Type:** String (URL)
- **Required:** No (required if enabling Google OAuth)
- **Description:** Redirect URI for Google OAuth callback
- **Example:** `GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback`
- **Note:** Must match the URI configured in Google Cloud Console

**Note:** If all three Google OAuth variables are provided, Google authentication will be enabled. If any are missing, Google authentication will be disabled.

**Important:** The `GOOGLE_REDIRECT_URI` must match your backend domain and should be in the format: `http://YOUR_DOMAIN:PORT/api/google/callback`

---

### File Storage

#### `UPLOAD_DIR`

- **Type:** String (Path)
- **Required:** No
- **Default:** `./uploads`
- **Description:** Directory path for storing uploaded files
- **Example:** `UPLOAD_DIR=./uploads`
- **Absolute Path Example:** `UPLOAD_DIR=/var/www/uploads`
- **Note:** Ensure the directory exists and is writable
- **Note:** If a user has custom drive enabled in their settings, files are uploaded to their custom drive path instead.

#### `STORAGE_LIMIT`

- **Type:** Number (Bytes)
- **Required:** No
- **Default:** `107374182400` (100 GB)
- **Description:** Storage limit per user in bytes
- **Example:** `STORAGE_LIMIT=1073741824` (1 GB)
- **Common Values:**
  - 1 GB: `1073741824`
  - 5 GB: `5368709120`
  - 10 GB: `10737418240`
- **Note:** If a user has custom drive enabled, the storage dashboard shows the actual disk space available on their custom drive path.

#### `STORAGE_PATH`

- **Type:** String (Path)
- **Required:** No
- **Default:** Backend directory
- **Description:** Base path for disk space calculation (used when custom drive is disabled)
- **Example:** `STORAGE_PATH=/var/www/storage`
- **Note:** Only used for disk space calculation, not for file storage location
- **Note:** If a user has custom drive enabled, disk space is calculated from their custom drive path instead.

---

### Custom Drive Integration (Per-User Settings)

Custom drive is now configured **per-user** in the web application settings. Administrators can enable/disable custom drive and set custom drive paths for each user from the Settings page.

**How It Works:**

- Administrators configure custom drive for users in the Settings page (not via environment variables)
- Only administrators can manage custom drive settings
- Each user can have their own custom drive path configured by an administrator
- Files are stored directly in the user's custom drive path with original filenames
- Storage dashboard shows actual disk space available on the user's custom drive
- File system watcher automatically syncs changes in real-time

**Behavior When Custom Drive is Enabled (Per User):**

| Setting         | Normal Mode                  | Custom Drive Mode (User)                                       |
|-----------------|------------------------------|----------------------------------------------------------------|
| `UPLOAD_DIR`    | Final storage location       | **Ignored** - uploads go directly to user's custom drive path  |
| `STORAGE_LIMIT` | Enforced per-user limit      | **Ignored** - uses actual disk space on custom drive           |
| `STORAGE_PATH`  | Disk space calculation path  | **Ignored** - uses user's custom drive path                    |

#### `CUSTOM_DRIVE_MOUNT_N` (Docker Only - Optional)

- **Type:** String (Host:Container Path Mapping)
- **Required:** No
- **Description:** Mount host directories for users to use as custom drive paths. Supports multiple mounts (CUSTOM_DRIVE_MOUNT_1, CUSTOM_DRIVE_MOUNT_2, CUSTOM_DRIVE_MOUNT_3, etc.)
- **Format:** `/host/path:/container/path` (REQUIRED - must include colon separator)
- **Linux Example:** `CUSTOM_DRIVE_MOUNT_1=/mnt/nas_drive:/data/custom_drive`
- **Windows Example:** `CUSTOM_DRIVE_MOUNT_1=C:/Users/username/my_drive:/data/custom_drive`
- **Note:**
  - These are only used by Docker Compose to mount volumes
  - Format MUST include colon separator (host:container)
  - Leave empty if not using that mount slot (will use safe placeholder)
  - Backend will reject placeholder paths if users try to use them
  - All custom drive paths MUST be mounted as volumes in Docker
  - The backend will NOT create directories - they must already exist as mounted volumes
- **See:** [Docker Guide - Custom Drive](docker.md#custom-drive-with-docker) for complete setup instructions.

**Admin Configuration:**

Custom drive settings are managed by administrators (first user) from the Settings page:

1. Navigate to Settings (admin access required)
2. Go to "Custom Drive Management" section
3. For each user, enable "Use Custom Drive" toggle
4. Enter the absolute path to the custom drive directory for that user
5. Click "Save" to apply changes
6. The system validates the path and starts watching for changes

**Note:** Only administrators can manage custom drive settings. Regular users cannot configure their own custom drive settings.

---

### Logging Configuration

#### `LOG_LEVEL`

- **Type:** String
- **Required:** No
- **Default:** `info` (production), `debug` (development)
- **Values:** `fatal`, `error`, `warn`, `info`, `debug`, `trace`
- **Description:** Sets the minimum log level for the application
- **Example:** `LOG_LEVEL=debug`
- **Note:**
  - `debug` and `trace` levels automatically mask secrets (JWTs, passwords, cookies, tokens)
  - Recommended: `info` for production, `debug` for development

#### `LOG_FORMAT`

- **Type:** String
- **Required:** No
- **Default:** `json` (production), `pretty` (development)
- **Values:** `json` or `pretty`
- **Description:** Log output format
- **Example:** `LOG_FORMAT=pretty`
- **Format Details:**
  - `json`: Structured JSON logs (best for log aggregation and production)
  - `pretty`: Human-readable colored logs (best for development)

#### `METRICS_ALLOWED_IPS`

- **Type:** String (Comma-separated)
- **Required:** No
- **Default:** `127.0.0.1,::1`
- **Description:** IP addresses allowed to access metrics endpoint
- **Example:** `METRICS_ALLOWED_IPS=127.0.0.1,::1`
- **Note:** Restricts access to `/metrics` endpoint for security

### Audit Logging Configuration

#### `AUDIT_WORKER_CONCURRENCY`

- **Type:** Number
- **Required:** No
- **Default:** `5`
- **Description:** Number of concurrent audit events the worker can process
- **Example:** `AUDIT_WORKER_CONCURRENCY=10`
- **Note:** Higher values process audit logs faster but use more database connections

#### `AUDIT_JOB_TTL_SECONDS`

- **Type:** Number (seconds)
- **Required:** No
- **Default:** `82800` (23 hours)
- **Description:** Time-to-live for queued audit jobs. Must be **less than 24 hours** due to pg-boss policy.
- **Example:** `AUDIT_JOB_TTL_SECONDS=7200` (2 hours)
- **Note:** If you set this, keep it under `86400` seconds; recommended to stay slightly below 24h (e.g., 23h).

---

## Frontend Environment Variables

**No frontend environment variables are required!**

TMA Cloud uses a **Single-Origin Architecture** where the backend serves both the frontend and the API from the same domain. This means:

- ✅ No `VITE_API_URL` needed - frontend uses relative URLs
- ✅ No `ONLYOFFICE_JS_URL` needed - fetched dynamically from backend
- ✅ No CORS configuration needed
- ✅ Simplified deployment

### How It Works

**Production:**

- Backend serves built frontend from `frontend/dist/` at `/`
- API endpoints available at `/api/*` and `/s/*`
- All requests are same-origin

**Development:**

- Vite dev server runs on `http://localhost:5173`
- Vite proxy forwards `/api/*` and `/s/*` to backend on `http://localhost:3000`
- No environment variables needed

---
