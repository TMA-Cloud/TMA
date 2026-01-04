# Features Documentation

Feature list for TMA Cloud.

## Authentication

- Email/password authentication with bcrypt
- JWT token-based sessions (httpOnly cookies)
- Google OAuth (optional)
- Multi-factor authentication (MFA) with TOTP
- Session security: token versioning, session binding, active sessions management
- Signup control: first user can enable/disable signup

## File Management

- Upload, download, organize files and folders
- Create folders, move, copy, rename, delete to trash
- Star/unstar files
- Search functionality
- Grid and list view modes
- Sort by name, date, size, type
- Real-time file events (Redis pub/sub + SSE)

## Sharing

- Create shareable links for files and folders
- Public access without login
- Share management (view, copy, revoke)
- Custom share domain support (isolate traffic)

## OnlyOffice Integration

- Online document editing (.docx, .xlsx, .pptx)
- PDF viewing
- Configured via Settings page (admin-only)
- Requires `BACKEND_URL` environment variable

## Storage Management

- Per-user storage limits
- Usage tracking and visual charts
- Custom drive support (per-user, admin-configured)
- Disk space monitoring

## File Organization

- Hierarchical folder structure
- Trash system (soft delete, restore, permanent delete)
- Automatic trash cleanup after 15 days
- Starred files quick access

## Search

- Full-text search across file names
- PostgreSQL full-text search index
- Real-time search results

## Background Services

- **Trash Cleanup:** Automatic deletion after 15 days
- **Orphan Cleanup:** Removes files without database records
- **Custom Drive Scanner:** Watches and syncs external drives per-user
- **Audit Worker:** Processes audit events asynchronously

## User Interface

- Light/dark theme with system preference detection
- Responsive design: separate mobile (≤1024px) and desktop (>1024px) UIs
- Mobile: bottom navigation, bottom sheet context menu, full-screen image viewer
- Desktop: sidebar navigation, right-click context menu, modal image viewer
- Keyboard navigation and accessibility support

## Security Features

- JWT token expiration and httpOnly cookies
- Secure password hashing (bcrypt)
- Multi-factor authentication (TOTP-based)
- Rate limiting (auth: 5/15min, API: 100/15min, upload: 50/hour)
- Input validation and sanitization
- SQL injection protection
- XSS protection
- Path traversal protection
- CSRF protection
- Session hijacking protection
- Audit trail for all critical operations
- Secret masking in logs

## Performance

- Redis caching for file listings, search results, user data
- Automatic cache invalidation on mutations
- Non-blocking operations
- Database indexing
- Background processing
