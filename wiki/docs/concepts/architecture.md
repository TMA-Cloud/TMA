# Architecture Overview

System architecture and design patterns for TMA Cloud.

## System Architecture

TMA Cloud uses **Single-Origin Architecture** - backend serves both API and frontend from the same origin.

### Production Architecture

```
Browser → Express Backend (/: Static Files, /api/*: API, /s/*: Share Links)
         ↓
    PostgreSQL + Redis (Cache)
```

### Development Architecture

```
Browser → Vite Dev Server (:5173) → Proxies /api/* and /s/* to Backend (:3000)
         ↓
    PostgreSQL + Redis
```

**Benefits:** No CORS issues, simplified deployment, cookie-based auth, no frontend env vars needed.

### Custom Share Domain (Optional)

When `SHARE_BASE_URL` is configured, share links can use a dedicated domain. Share domain middleware blocks all routes except `/s/*`, `/health`, and `/metrics`.

## Backend Structure

```
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

```
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

**Authentication:** Login → JWT token → httpOnly cookie → AuthContext updates

**File Upload:** FormData → POST /api/files/upload → File saved → Database record → Response

**Share Link:** POST /api/files/share → Share link created → Token generated → Response with URL

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
