# Architecture Overview

System architecture and design patterns for TMA Cloud.

## System Architecture

TMA Cloud uses **Single-Origin Architecture** - backend serves both API and frontend from the same origin.

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
- **Services:** Background processes (cleanup, scanning, audit logging)
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
