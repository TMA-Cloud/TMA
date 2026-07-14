# Architecture Overview

System architecture and design patterns for TMA Cloud.

## System Architecture

TMA Cloud uses **Single-Origin Architecture**:

- **Production:** The Express backend serves both the built frontend and all APIs from the same origin.
- **Development:** The browser loads the app from the Vite dev server at `http://localhost:5173`, which proxies `/api/*` and `/s/*` to the backend on `http://localhost:3000`.

### Production Architecture

```bash
┌─────────┐
│ Browser │
└────┬────┘
     │
     │ HTTP Requests
     │
┌────▼─────────────────────────────────────────────┐
│         Express Backend (:3000)                  │
│  ┌──────────────────────────────────────────┐    │
│  │ /          → Static Frontend Files       │    │
│  │ /api/*     → API Endpoints               │    │
│  │ /s/*       → Share Links                 │    │
│  │ /health    → Health Check                │    │
│  │ /metrics   → Prometheus Metrics          │    │
│  └──────────────────────────────────────────┘    │
└────┬───────────────────┬─────────────────────────┘
     │                   │
     │                   │
┌────▼─────┐      ┌──────▼──────┐
│PostgreSQL│      │    Redis    │
│ Database │      │   (Cache)   │
└──────────┘      └─────────────┘
```

### Development Architecture

```bash
┌─────────┐
│ Browser │
└────┬────┘
     │
     │ HTTP Requests
     │
┌────▼──────────────────────────────────────┐
│     Vite Dev Server (:5173)               │
│  ┌────────────────────────────────────┐   │
│  │ Frontend Development Server        │   │
│  │ Proxies /api/* → Backend (:3000)   │   │
│  │ Proxies /s/*   → Backend (:3000)   │   │
│  └────────────────────────────────────┘   │
└────┬──────────────────────────────────────┘
     │
     │ Proxy Requests
     │
┌────▼─────────────────────────────────────┐
│      Express Backend (:3000)             │
│  ┌────────────────────────────────────┐  │
│  │ API Endpoints                      │  │
│  │ Share Links                        │  │
│  └────────────────────────────────────┘  │
└────┬───────────────────┬─────────────────┘
     │                   │
     │                   │
┌────▼─────┐      ┌──────▼──────┐
│PostgreSQL│      │    Redis    │
│ Database │      │   (Cache)   │
└──────────┘      └─────────────┘
```

**Benefits:** No CORS issues, simplified deployment, cookie-based auth, no frontend env vars needed.

### Custom Share Domain (Optional)

Configure custom share base URL in Settings → Share Base URL (admin only). When configured, share links use the custom domain. Share domain middleware blocks all routes except `/s/*`, `/health`, and `/metrics`.

## Backend Structure

```bash
backend/
├── config/          # Configuration (database, redis, logger)
├── controllers/     # Request handlers
├── middleware/      # Express middleware (auth, error handling)
├── migrations/      # Database migrations
├── models/          # Data models
├── routes/          # API routes
├── services/        # Background services
└── utils/           # Utilities
```

**Key Components:**

- **Controllers:** Handle HTTP requests and business logic
- **Middleware:** Auth, error handling, rate limiting, share domain blocking
- **Models:** Database abstraction layer
- **Services:** Background processes (cleanup, scanning, audit logging, OnlyOffice auto-save)
- **Caching:** Redis-based caching with automatic invalidation
- **Real-Time Events:** Redis pub/sub + SSE for file event broadcasting

## Frontend Structure

```bash
frontend/src/
├── components/   # React components
├── contexts/     # State management
├── hooks/        # Custom hooks
└── utils/        # Utilities
```

**Key Features:**

- **Responsive Design:** Separate mobile (≤1024px) and desktop (>1024px) UIs
- **Contexts:** AuthContext, AppContext, ThemeContext
- **Viewers:** Image and document viewers with device-specific implementations

## Electron Desktop App

Optional Windows client. Loads the same frontend from the TMA Cloud server URL; no separate frontend build.

### Electron Architecture

```bash
┌─────────────────────────────────────────────────────────────────┐
│  Main Process (Node)                                            │
│  src/main: createWindow, getServerUrl(), IPC                    │
│  Server URL: embedded at build, or userData/config.json,        │
│  or electron/src/config/build-config.json (dev)                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │ loadURL(serverUrl)
                               │ IPC
┌──────────────────────────────▼──────────────────────────────────┐
│  Renderer (BrowserWindow)                                       │
│  Same React frontend as web; origin = server URL                │
│  Preload (src/preload) exposes window.electronAPI to renderer   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ fetch /api/* (same origin, cookies)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  TMA Cloud Backend                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Electron Folder Structure

```bash
electron/
├── src/
│   ├── main/         # Main process: window, server URL, IPC
│   ├── preload/       # contextBridge, exposes electronAPI
│   ├── config/       # build-config.json (serverUrl when run from source)
│   └── build/        # electron-builder configs + icon
├── scripts/          # prepare-client-build.js
└── dist-electron/    # Staging for packaging (generated)
```

**Main process:** Creates a single BrowserWindow; loads a loading page, then the server URL. Resolves server URL from embedded constant (at build time) or `src/config/build-config.json` (when run from source).

**Preload:** contextIsolation: true, nodeIntegration: false. Exposes a small API (e.g. `electronAPI.clipboard`) via contextBridge and ipcRenderer.invoke.

**Renderer:** Same React app as web. Detects Electron via `window.electronAPI` and uses it where needed; all API calls go to the same backend via fetch.

Some deployments enable an optional mode where the desktop app is only allowed. In that mode, normal browsers are blocked from the main app while share links continue to work.

### Cloud Drive (WinFsp)

The desktop app can mount TMA Cloud as a Windows drive so files can be opened and saved from any application's file dialogs. It has two parts:

- **`desktop-fs`** — a small .NET host (`TmaCloudFs.exe`) built on [WinFsp](https://winfsp.dev). It presents the drive to Windows and translates filesystem operations into requests, but holds no credentials.
- **`electron/src/main/clouddrive.cjs`** — the trusted half. The host forwards each operation over a local named pipe (newline-delimited JSON); the main process runs the matching authenticated call to `/api/*` using the app's session cookies, so the drive reuses the same auth, permissions, and audit as the rest of the app.

```bash
Any app's Save As → Z:\ TMA Cloud (WinFsp)
        │  named pipe (JSON)
   TmaCloudFs.exe (desktop-fs, no credentials)
        │
   Electron main (clouddrive.cjs, session cookies) → /api/* → backend
```

The main process mounts the drive when the auth cookie appears (sign-in) and unmounts on sign-out or app close. Directory listings are cached briefly and refreshed by the backend event stream. See [Desktop App — Cloud Drive](/getting-started/desktop-app#cloud-drive-mounted-windows-drive).

## Data Flow

### Authentication Flow

```bash
┌─────────┐     POST /api/login       ┌──────────┐
│ Browser │ ────────────────────────> │ Backend  │
└─────────┘                           └────┬─────┘
     │                                     │
     │                                     │ Validate credentials
     │                                     │ Create session
     │                                     │ Generate JWT token
     │                                     │
     │<────────────────────────────────────┘
     │ Set httpOnly cookie
     │
┌────▼─────────┐
│ AuthContext  │
│   Updated    │
└──────────────┘
```

### File Upload Flow

```bash
┌──────────┐     POST /api/files/upload     ┌──────────┐
│ Browser  │ ─────────────────────────────> │ Backend  │
│(FormData)│                                └────┬─────┘
└──────────┘                                     │
                                                 │ Validate & save file
                                                 │ Stream to storage (local or S3)
                                                 │ Create database record
                                                 │ Update cache
                                                 │
┌─────────┐     Response with file info          │
│ Browser │<─────────────────────────────────────┘
└─────────┘
```

**Storage:** Local disk (`UPLOAD_DIR`) or S3-compatible object storage (when `STORAGE_DRIVER=s3`). Same streaming and encryption for both.

### Share Link Flow

```bash
┌─────────┐     POST /api/files/share      ┌──────────┐
│ Browser │ ─────────────────────────────> │ Backend  │
└─────────┘                                └────┬─────┘
                                                │
                                                │ Create share link
                                                │ Generate token
                                                │ Link files
                                                │
┌─────────┐     Response with share URL         │
│ Browser │<────────────────────────────────────┘
└─────────┘
```

## Database Schema

Key tables: `users`, `files`, `share_links`, `share_link_files`, `audit_logs`, `sessions`, `app_settings`

See [Database Schema](/reference/database-schema) for details.

## Security

- JWT tokens in httpOnly cookies
- Input validation and sanitization
- SQL injection protection (parameterized queries)
- XSS protection (HTML escaping)
- Path traversal protection
- Rate limiting
- Security headers (CSP, X-Frame-Options, etc.)

## Logging & Audit

- **Structured Logging:** Pino with automatic secret masking
- **Audit Trail:** Queue-based system (pg-boss) with async worker
- **Request Logging:** All requests logged with context

See [Logging](/guides/operations/logging) and [Audit Logs](/guides/operations/audit-logs) for details.

## Technology Stack

**Backend:** Express.js, PostgreSQL, Redis, JWT, Pino, pg-boss

**Frontend:** React 19, TypeScript, Vite, Tailwind CSS

**Integration:** OnlyOffice, Google OAuth
