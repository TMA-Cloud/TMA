# Environment Variables

Complete reference for all environment variables used in TMA Cloud.

## Backend Environment Variables

Create a `.env` file in the `backend/` directory with the following variables.

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

### Authentication

#### `JWT_SECRET`

- **Type:** String
- **Required:** Yes
- **Description:** Secret key for signing JWT tokens. Use a strong, random string.
- **Example:** `JWT_SECRET=your_super_secret_jwt_key_here`
- **Security:** Generate a strong random string (at least 32 characters)

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

#### `STORAGE_PATH`

- **Type:** String (Path)
- **Required:** No
- **Default:** Backend directory
- **Description:** Base path for disk space calculation (used when custom drive is disabled)
- **Example:** `STORAGE_PATH=/var/www/storage`
- **Note:** Only used for disk space calculation, not for file storage location

---

### Backend OnlyOffice Integration (Optional)

#### `ONLYOFFICE_JWT_SECRET`

- **Type:** String
- **Required:** No (required if using OnlyOffice with JWT)
- **Description:** JWT secret for OnlyOffice document server communication
- **Example:** `ONLYOFFICE_JWT_SECRET=your_onlyoffice_jwt_secret`
- **Note:** Must match the secret configured in OnlyOffice Document Server. If not set, OnlyOffice integration runs without JWT.

#### `ONLYOFFICE_URL`

- **Type:** String (URL)
- **Required:** No
- **Default:** `http://localhost:2202`
- **Description:** Base URL of OnlyOffice Document Server (used for viewer page generation)
- **Example:** `ONLYOFFICE_URL=http://localhost:2202`
- **Production Example:** `ONLYOFFICE_URL=https://documentserver.example.com`
- **Note:** Used to construct the JavaScript API URL for standalone viewer pages

---

### Custom Drive Integration (Optional)

#### `CUSTOM_DRIVE`

- **Type:** String
- **Required:** No
- **Values:** `yes` or `no`
- **Default:** `no`
- **Description:** Enable custom drive scanning service
- **Example:** `CUSTOM_DRIVE=yes`

#### `CUSTOM_DRIVE_PATH`

- **Type:** String (Absolute Path)
- **Required:** No (required if `CUSTOM_DRIVE=yes`)
- **Description:** Absolute path to the directory to scan and sync
- **Example:** `CUSTOM_DRIVE_PATH=/mnt/external_drive`
- **Windows Example:** `CUSTOM_DRIVE_PATH=C:\ExternalDrive`
- **Note:** Must be an absolute path. The service will watch this directory for changes.

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
