# Architecture Overview

This document provides an overview of the TMA Cloud architecture, including system design, components, and data flow.

## System Architecture

TMA Cloud uses a **Single-Origin Architecture** where the backend serves both the API and the frontend from the same origin, eliminating CORS issues.

### Production Architecture

```bash
┌─────────────────────────────────────────────┐
│              Browser (Client)               │
└──────────────────┬──────────────────────────┘
                   │ http://localhost:3000
                   │ (Single Origin)
                   ▼
┌─────────────────────────────────────────────┐
│         Express Backend Server              │
│  ┌──────────────────┐  ┌─────────────────┐ │
│  │  Static Files    │  │   API Routes    │ │
│  │  (Frontend UI)   │  │   /api/*        │ │
│  │  Served at /     │  │   /s/*          │ │
│  └──────────────────┘  └─────────────────┘ │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
            ┌─────────────┐
            │ PostgreSQL  │
            │  Database   │
            └─────────────┘
```

### Development Architecture

```bash
┌──────────────┐                 ┌─────────────┐
│   Browser    │                 │   Backend   │
└──────┬───────┘                 │  (Express)  │
       │                         │   :3000     │
       │ http://localhost:5173   │             │
       ▼                         └──────┬──────┘
┌─────────────────────────┐            │
│  Vite Dev Server        │            │
│  ┌──────────────────┐   │            │
│  │  Frontend (HMR)  │   │            ▼
│  └──────────────────┘   │     ┌─────────────┐
│  ┌──────────────────┐   │     │ PostgreSQL  │
│  │  Proxy to :3000  │───┼────►└─────────────┘
│  │  /api/* → :3000  │   │
│  │  /s/* → :3000    │   │
│  └──────────────────┘   │
└─────────────────────────┘
```

### Key Benefits

- ✅ **No CORS issues**: Same origin for frontend and backend
- ✅ **Simplified deployment**: Single server, single port
- ✅ **Better security**: No cross-origin requests in production
- ✅ **Cleaner config**: No frontend environment variables needed
- ✅ **Cookie-based auth**: Works seamlessly across the application

### Custom Share Domain Architecture (Optional)

When `SHARE_BASE_URL` is configured, the system supports routing share links to a dedicated domain:

```bash
┌─────────────────────────────────────────────┐
│              Browser (Client)               │
└──────┬──────────────────────┬───────────────┘
       │                      │
       │ Main App             │ Share Links
       │ main.example.com     │ share.example.com
       ▼                      ▼
┌──────────────────┐  ┌───────────────────────┐
│  Express Server  │  │  Express Server       │
│  ┌────────────┐  │  │  ┌─────────────────┐  │
│  │ Full App   │  │  │  │ Share Domain    │  │
│  │ /api/*     │  │  │  │ Blocking        │  │
│  │ /          │  │  │  │ Middleware      │  │
│  │ Static     │  │  │  └─────────────────┘  │
│  └────────────┘  │  │  ┌─────────────────┐  │
│                  │  │  │ Only /s/*       │  │
│                  │  │  │ routes allowed  │  │
│                  │  │  │ All others: 404 │  │
│                  │  │  └─────────────────┘  │
└──────────────────┘  └───────────────────────┘
       │                      │
       └──────────┬───────────┘
                  ▼
            ┌─────────────┐
            │ PostgreSQL  │
            │  Database   │
            └─────────────┘
```

**Request Flow on Share Domain:**

1. Request arrives at `share.example.com`
2. **Share Domain Middleware** checks:
   - If path is `/s/*`, `/health`, or `/metrics` → Allow
   - Otherwise → Return 404 immediately (no further processing)
3. Share link routes handle `/s/*` requests normally
4. All other routes never execute (blocked early)

**Benefits:**

- **Traffic Isolation**: Share link traffic doesn't impact main app performance
- **Security**: Share domain locked down to only share endpoints
- **Scalability**: Can route share domain to CDN or separate infrastructure
- **Early Blocking**: Non-share routes blocked before logging/parsing (minimal overhead)

## Backend Architecture

### Backend Directory Structure

```bash
backend/
├── config/          # Configuration files (database, paths)
├── controllers/     # Request handlers (business logic)
├── middleware/      # Express middleware (auth, error handling)
├── migrations/      # Database migration files
├── models/          # Data models and database queries
├── routes/          # API route definitions
├── services/        # Background services (cleanup, scanning)
├── utils/           # Utility functions
└── uploads/         # File storage directory
```

### Backend Key Components

#### 1. **Controllers**

Handle HTTP requests and implement business logic:

- `auth.controller.js` - Authentication and user management
- `file.controller.js` - File operations (CRUD, move, copy, share)
- `share.controller.js` - Share link handling
- `onlyoffice.controller.js` - OnlyOffice integration
- `user.controller.js` - User profile and storage

#### 2. **Middleware**

- `requestId.middleware.js` - Request ID generation for tracing (runs first)
- `shareDomain.middleware.js` - Blocks main app access on share domain (runs early, before logging)
- `auth.middleware.js` - JWT token verification
- `error.middleware.js` - Centralized error handling (runs last)
- `rateLimit.middleware.js` - Rate limiting for API endpoints

#### 3. **Models**

Database abstraction layer:

- `user.model.js` - User data operations
- `file.model.js` - File and folder operations
- `share.model.js` - Share link operations

#### 4. **Services**

Background processes:

- `trashCleanup.js` - Automatic trash deletion
- `orphanCleanup.js` - Cleanup of orphaned files
- `customDriveScanner.js` - Custom drive synchronization
- `auditLogger.js` - Audit event logging service

#### 5. **Routes**

API endpoint definitions:

- `/api` - Authentication endpoints
- `/api/files` - File management endpoints
- `/api/user` - User endpoints
- `/api/onlyoffice` - OnlyOffice endpoints
- `/s` - Public share endpoints
- `/metrics` - Application metrics (restricted by IP)

#### 6. **Workers**

Standalone worker processes:

- `audit-worker.js` - Processes audit events from queue and writes to database

## Frontend Architecture

### Frontend Directory Structure

```bash
frontend/
├── src/
│   ├── components/   # React components
│   │   ├── auth/     # Authentication components
│   │   ├── dashboard/# Dashboard components
│   │   ├── fileManager/ # File management UI
│   │   ├── folder/   # Folder creation
│   │   ├── layout/   # Layout components (desktop)
│   │   ├── mobile/   # Mobile-specific components
│   │   ├── settings/ # Settings page
│   │   ├── upload/   # Upload functionality
│   │   ├── viewer/   # File viewers
│   │   └── ui/       # Reusable UI components
│   ├── contexts/     # React contexts (state management)
│   ├── hooks/        # Custom React hooks
│   └── utils/        # Utility functions
```

### Frontend Key Components

#### 1. **Contexts**

Global state management:

- `AuthContext` - User authentication state
- `AppContext` - Application state (current path, sidebar, etc.)
- `ThemeContext` - Dark/light theme

#### 2. **Layout Components**

**Desktop Layout** (> 1024px):

- `Header` - Top navigation bar with search and user profile
- `Sidebar` - Left sidebar navigation menu
- `AppContent` - Main desktop layout wrapper

**Mobile Layout** (≤ 1024px):

- `MobileAppContent` - Dedicated mobile layout with bottom navigation
- Compact header with app logo and essential controls
- Bottom navigation bar for easy thumb access

#### 3. **File Management Components**

- **Desktop**: `FileManager`, `FileItem`, `Breadcrumbs` - Traditional file browsing
- **Mobile**: Same components with mobile-optimized styling and interactions
- **Context Menu**:
  - Desktop: Right-click floating menu
  - Mobile: Bottom sheet with press-and-hold activation

#### 4. **Viewer Components**

**Image Viewers**:

- `ImageViewerModal` - Router component that detects viewport and routes to appropriate viewer
- `DesktopImageViewer` - Modal-based viewer for desktop with fit-to-screen default
- `MobileImageViewer` - Full-screen Google Drive-like viewer with pinch-zoom and swipe navigation

**Document Viewer**:

- `DocumentViewerModal` - OnlyOffice document viewer

#### 5. **Modals**

- `UploadModal` - File upload interface
- `RenameModal` - File/folder renaming
- `ShareLinkModal` - Share link management
- `CreateFolderModal` - Folder creation

#### 6. **Hooks**

- `useIsMobile` - Viewport detection hook (detects ≤ 1024px as mobile)
- `useToast` - Toast notification system
- `useStorageUsage` - Storage quota tracking

#### 7. **Utils**

- `api.ts` - API client functions
- `fileUtils.ts` - File-related utilities
- `debounce.ts` - Debounce utility

## Data Flow

### Authentication Flow

```bash
1. User submits login form
2. Frontend sends POST /api/login
3. Backend validates credentials
4. Backend generates JWT token
5. Token stored in httpOnly cookie
6. Frontend receives success response
7. AuthContext updates user state
8. User redirected to dashboard
```

### File Upload Flow

```bash
1. User selects file(s) to upload
2. Frontend creates FormData
3. POST /api/files/upload with file and path
4. Backend validates file and user storage
5. File saved to uploads/ directory
6. Database record created
7. Response with file metadata
8. Frontend refreshes file list
```

### Share Link Flow

```bash
1. User selects file/folder to share
2. POST /api/files/share
3. Backend creates share_link record
4. Unique token generated
5. Response with share URL
6. User can copy/share the link
7. Public access via /s/:token
```

## Database Schema

See [Database Schema](database.md) for detailed table structures.

Key tables:

- `users` - User accounts
- `files` - Files and folders
- `share_links` - Share link metadata
- `share_link_files` - Files included in share links
- `audit_logs` - Audit trail events
- `pgboss.*` - pg-boss job queue tables
- `migrations` - Migration tracking

## Security

### Authentication

- JWT tokens stored in httpOnly cookies
- Tokens expire after a set duration
- Middleware validates tokens on protected routes

### File Security

- Files stored outside web root
- Access controlled by user ownership
- Share links use cryptographically secure tokens

### API Security

- **Single-Origin Architecture**: No CORS needed, frontend and backend on same domain
- **Security Headers**: XSS protection, CSP, frame options, referrer policy
- **Input Validation**: All user input validated and sanitized
- **Error Handling**: Generic error messages prevent information leakage
- **ONLYOFFICE Integration**: CSP allows configured document server origin

## Logging Architecture

### Logging System

TMA Cloud uses **Pino** for high-performance structured logging:

```bash
┌─────────────────┐
│  Application    │
│  (Controllers,  │
│   Middleware)   │
└────────┬────────┘
         │ logger.info()
         │ logger.error()
         ▼
┌─────────────────┐
│  Pino Logger    │
│  - Masking      │
│  - Formatting   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  stdout/stderr  │
│  (JSON/Pretty)  │
└─────────────────┘
```

**Features:**

- **Structured Logging**: JSON-formatted logs for easy parsing
- **Secret Masking**: Automatic redaction of JWTs, passwords, cookies, tokens
- **Multiple Formats**: JSON (production) or Pretty (development)
- **Request Logging**: HTTP middleware logs all requests with context
- **Context Propagation**: Request ID and user ID tracked across logs

**Configuration:**

- `LOG_LEVEL`: Sets minimum log level (debug, info, warn, error)
- `LOG_FORMAT`: Output format (json, pretty)

See [Logging Documentation](logging.md) for detailed information.

## Audit System Architecture

### Audit Logging Flow

```bash
┌──────────────────┐
│   Controller     │
│   (User Action)  │
└────────┬─────────┘
         │ logAuditEvent()
         │ (non-blocking)
         ▼
┌──────────────────┐
│    pg-boss       │
│  Message Queue   │
│   (PostgreSQL)   │
└────────┬─────────┘
         │ job: audit-log
         │
         ▼
┌──────────────────┐
│  Audit Worker    │
│ (audit-worker.js)│
│  - Concurrency   │
│  - Retry Logic   │
└────────┬─────────┘
         │ INSERT
         ▼
┌──────────────────┐
│  audit_logs      │
│     Table        │
│  - event_type    │
│  - user_id       │
│  - metadata      │
│  - timestamp     │
└──────────────────┘
```

### Key Components

#### 1. **Audit Logger Service** (`services/auditLogger.js`)

- Provides `logAuditEvent()` function
- Queues events to pg-boss
- Fire-and-forget pattern (non-blocking)
- Includes user context, IP, user agent

#### 2. **Audit Worker** (`audit-worker.js`)

- Standalone Node.js process
- Listens to pg-boss queue
- Processes events asynchronously
- Configurable concurrency
- Automatic retry on failure

#### 3. **Audit Database** (`audit_logs` table)

- Stores all audit events
- JSONB metadata for flexible querying
- Indexed for performance
- Foreign key to users table

### Audit Event Types

- **Authentication**: login, logout, signup, failures
- **Files**: upload, download, delete, move, copy, rename, star
- **Folders**: create, delete, move, copy
- **Shares**: create, delete, access
- **Documents**: open, save (OnlyOffice)
- **Settings**: signup toggle

**Configuration:**

- `AUDIT_WORKER_CONCURRENCY`: Number of concurrent audit processing jobs

See [Audit Documentation](audit.md) for detailed information.

## Background Services

### Trash Management

- Soft delete: Files are marked as deleted with `deleted_at` timestamp
- Restore functionality: Files can be restored to their original location
  - Validates parent folder existence
  - Handles name conflicts automatically
  - Transaction-safe restore operations
- Trash Cleanup: Automatically deletes files from trash after 15 days
- Runs periodically via scheduler
- Runs periodically via scheduler

### Orphan Cleanup

- Removes files without valid database records
- Prevents storage bloat

### Custom Drive Scanner

- Per-user external drive integration service
- Watches for file changes in user-specific custom drive directories
- Syncs file changes to database automatically
- Configured per-user by administrators via Settings page
- Each user can have their own custom drive path
- Real-time file system watching for changes

### Audit Worker

- Processes audit events from queue
- Writes events to audit_logs table
- Runs as separate process (`npm run worker`)

## Scalability Considerations

### Current Limitations

- Single server deployment
- File storage on local filesystem
- No load balancing

### Potential Improvements

- Object storage (S3, Azure Blob) for files
- Redis for session management
- CDN for static assets
- Horizontal scaling with load balancer
- Database read replicas

## Technology Choices

### Backend

- **Express.js**: Mature, flexible web framework
- **PostgreSQL**: Reliable relational database
- **JWT**: Stateless authentication
- **Multer**: File upload handling
- **Pino**: High-performance structured logging
- **pg-boss**: PostgreSQL-based job queue for audit events

### Frontend

- **React 19**: Modern UI library
- **TypeScript**: Type safety
- **Vite**: Fast build tool
- **Tailwind CSS**: Utility-first styling
- **Responsive Design**: Dedicated mobile and desktop UI implementations
- **Viewport Detection**: Automatic mobile/desktop UI switching based on viewport size

### Integration

- **OnlyOffice**: Document editing capabilities
- **Google OAuth**: Social authentication option

### Monitoring & Logging

- **Pino**: Fast structured JSON logging
- **pino-http**: HTTP request logging middleware
- **pino-pretty**: Development-friendly log formatting
- **pg-boss**: Reliable queue-based audit logging
