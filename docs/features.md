# Features Documentation

Detailed documentation of TMA Cloud features and functionality.

## Authentication

### Email/Password Authentication

Users can create accounts and log in with email and password:

- Secure password hashing with bcrypt
- JWT token-based sessions
- HttpOnly cookies for token storage
- Password validation requirements

### Google OAuth (Optional)

Optional Google OAuth integration:

- One-click login with Google account
- Automatic account creation
- Linked accounts support
- Configurable via environment variables

**Setup:**

1. Create Google OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/)
2. Configure environment variables (see [Environment Variables](environment.md#google-oauth-20-optional))
   - `GOOGLE_CLIENT_ID` - OAuth client ID
   - `GOOGLE_CLIENT_SECRET` - OAuth client secret
   - `GOOGLE_REDIRECT_URI` - Must match backend domain: `http://YOUR_DOMAIN:PORT/api/google/callback`
3. Enable in application (automatically enabled when all three variables are set)

See [Setup Guide](setup.md#google-oauth-issues) for troubleshooting.

### Signup Control (Self-Hosted)

For self-hosted deployments, signup can be controlled to prevent unauthorized account creation:

- **Automatic Disable**: After the first user signs up, signup is automatically disabled
- **First User Control**: Only the first user (oldest account by creation date) can enable/disable signup
- **Settings Toggle**: First user can manage signup status from Settings page
- **Security Hardened**: Multiple layers of protection prevent unauthorized manipulation
  - Immutable first user ID stored in database
  - Foreign key constraint prevents first user deletion
  - Transaction-based operations prevent race conditions
  - Double verification at controller and model levels

**How It Works:**

1. Initially, signup is enabled (allows first user to register)
2. When the first user signs up, signup is automatically disabled
3. The first user's ID is permanently stored and cannot be changed
4. Only the first user can see and toggle the signup setting in Settings
5. All signup attempts (email/password and Google OAuth) respect the signup status

**Security Features:**

- First user ID is immutable once set
- Database foreign key prevents first user deletion
- All toggle operations use database transactions
- Unauthorized attempts are logged for security monitoring

## File Management

### File Operations

#### Upload

- Single or multiple file upload
- Drag and drop support
- Progress tracking
- Storage quota checking
- Automatic file type detection

#### Download

- **File Downloads**: Direct download with original filename and extension preserved
- **Folder Downloads**: Automatic ZIP compression before download
  - Folders are zipped on-the-fly when requested
  - Original folder structure is preserved in the ZIP
  - ZIP filename uses folder name with `.zip` extension
- **Multiple Downloads**: Support for downloading multiple files/folders sequentially
- **Progress Indication**: Visual progress indicator during download/zipping
- **Concurrent Request Prevention**: Mutex locks prevent multiple simultaneous zip operations per user
- **Share Link Downloads**: Download files and folders from share links
- **Filename Preservation**: Original filenames with extensions are maintained using RFC 5987 encoding for special characters

#### Organization

- Create folders
- Move files/folders
- Copy files/folders
- Rename items
- Delete to trash

#### Context Menu

**Desktop**:

- Right-click context menu with all file actions
- Keyboard navigation support (Arrow keys, Enter)
- Floating menu positioned at cursor

**Mobile**:

- Press-and-hold (500ms) to open context menu
- Bottom sheet action menu (Google Drive-like)
- Large, thumb-friendly action buttons
- Swipe down or tap outside to dismiss
- All file actions available: Share, Download, Star, Copy, Cut, Paste, Rename, Delete

### File Browser

- Grid and list view modes
- Breadcrumb navigation
- Search functionality
- Sort by name, date, size, type
- Sort order (ascending/descending)
- Filter by type

### File Metadata

Each file stores:

- Name and path
- MIME type
- File size
- Creation date
- Last modified date
- Parent folder reference
- User ownership

## Sharing

### Share Links

Create shareable links for files and folders:

- Unique token generation
- Optional expiration dates
- Public access without login
- Download and view permissions
- Share statistics

### Share Management

- View all created shares
- Copy share links
- Set expiration dates
- Revoke shares
- Track access
- Link files to parent folder shares

### Shared Files

- View files shared with you
- Access shared folders
- Download shared content

### Custom Share Domain

Configuring a dedicated domain or subdomain exclusively for public share links, separate from main application domain. This feature allows isolate share link traffic from main application.

**Performance Isolation**:

- Prevent share link traffic from impacting the main application performance
- Use a CDN or dedicated server for share links while keeping the main app on a different infrastructure
- Scale share link infrastructure independently

**Security Benefits**:

- The share domain is locked down to only serve `/s/*` routes (share links)
- All other routes (main app, API endpoints, static files) return 404 on the share domain
- Prevents accidental access to the main application via the share domain
- Reduces attack surface by isolating public share endpoints

**Operational Flexibility**:

- Use different SSL certificates or CDN configurations for share links
- Apply different rate limiting or caching strategies
- Monitor share link traffic separately from main app traffic
- Easier to migrate or change share link infrastructure without affecting main app

## OnlyOffice Integration

### Document Editing

Online document editing with OnlyOffice:

- Word documents (.docx)
- Spreadsheets (.xlsx)
- Presentations (.pptx)
- PDF viewing

### Features

- Real-time collaboration (if OnlyOffice configured)
- Save changes back to storage
- View-only mode
- Edit mode with permissions
- Version history (via OnlyOffice)

### Setup

1. Install OnlyOffice Document Server
2. Configure environment variables (see [Environment Variables](environment.md#backend-onlyoffice-integration-optional))
   - `ONLYOFFICE_JWT_SECRET` - JWT secret for document server communication
   - `ONLYOFFICE_URL` - Document server URL
   - `BACKEND_URL` - Public backend URL accessible by document server
3. No frontend configuration needed - OnlyOffice integration is handled automatically

See [Setup Guide](setup.md#onlyoffice-integration-issues) for troubleshooting.

## Version Management

### Version Checking

Functionality to check latest available version tags:

- Current Version Display
- Update Feed Integration
- Status Indicators

## Storage Management

### Storage Quotas

- Per-user storage limits
- Usage tracking
- Visual storage charts
- Quota warnings
- Upload blocking when limit reached

### Storage Statistics

- Total files count
- Total folders count
- Total storage used
- Storage percentage used
- Available space
- Custom drive storage calculation (when enabled)
- Disk space monitoring

## File Organization

### Folders

- Hierarchical folder structure
- Nested folders support
- Path-based navigation
- Folder metadata

### Starring

- Star important files/folders
- Quick access to starred items
- Star/unstar toggle

### Trash

- Soft delete to trash
- Restore from trash
  - Restore files/folders to original location
  - Automatic fallback to root if parent folder was deleted
  - Smart name conflict resolution (auto-renaming)
  - Recursive restore for entire folder trees
  - Transaction-safe operations
- Permanent deletion
- Empty trash functionality
- Automatic cleanup after 15 days

## Search

### File Search

- Full-text search across file names
- Search in current directory or all files
- Real-time search results
- Highlighted matches

### Search Index

- PostgreSQL full-text search
- Automatic indexing
- Fast search performance

## Background Services

### Trash Cleanup

Automatic cleanup service:

- Runs periodically
- Deletes files from trash after 15 days
- Prevents storage bloat
- Configurable retention period

### Orphan Cleanup

File system cleanup:

- Removes files without database records
- Prevents orphaned files
- Runs on schedule
- Safe cleanup process

### Custom Drive Scanner

Optional external drive integration:

- Watch external directory
- Sync files to cloud storage
- Automatic file detection
- Configurable via environment variables

**Setup:**

1. Set `CUSTOM_DRIVE=yes` in environment variables
2. Configure `CUSTOM_DRIVE_PATH` to absolute path of external directory
3. Service automatically syncs files

See [Environment Variables](environment.md#custom-drive-integration-optional) for configuration details.

### Audit Worker

Queue-based audit event processing system that writes audit events to the database asynchronously. The worker processes events from a PostgreSQL-based queue (pg-boss) and writes them to the `audit_logs` table.

**Key Features:**

- Processes audit events asynchronously (non-blocking)
- Writes to `audit_logs` database table
- Configurable concurrency (`AUDIT_WORKER_CONCURRENCY`)
- Automatic retry on failure
- Runs as separate process

**Setup:**

```bash
npm run worker
```

**Important:** The audit worker must be running in production. Without it, audit events are queued but not written to the database.

See [Audit Documentation](audit.md) for complete setup, configuration, and monitoring details.

## Logging and Monitoring

### Structured Logging

TMA Cloud uses **Pino** for high-performance structured logging with automatic secret masking, structured JSON logs, and request/response logging. All sensitive data (JWTs, passwords, cookies) is automatically redacted in logs.

**Key Features:**

- Structured JSON logs for easy parsing
- Automatic secret masking (passwords, tokens, cookies)
- Request/response logging with context propagation
- Multiple log levels (fatal, error, warn, info, debug, trace)
- Pretty-print format for development

See [Logging Documentation](logging.md) for complete details, configuration, and examples.

### Audit Trail

Comprehensive audit logging system tracks all critical user actions and system events. The system uses a queue-based architecture to ensure reliable event capture without impacting performance.

**Tracked Events:**

- **Authentication**: Login, logout, signup, failures
- **File Operations**: Upload, download, delete, move, copy, rename, star
- **Folder Operations**: Create, delete, move, copy
- **Share Operations**: Create, delete, access
- **Document Operations**: Open, save (OnlyOffice)
- **Settings**: Configuration changes

**Key Features:**

- Complete user activity tracking with IP addresses
- Rich metadata for each event (file names, sizes, types, destinations)
- PostgreSQL storage with queryable JSONB metadata
- Asynchronous processing via audit worker
- Success and failure status tracking

See [Audit Documentation](audit.md) for complete details, event types, query examples, and worker setup.

### Application Metrics

Monitor application health and performance via the `/metrics` endpoint. Access is restricted by IP address for security.

See [API Documentation - Metrics](api.md#monitoring) for endpoint details, available metrics, and configuration.

## User Interface

### Themes

- Light mode
- Dark mode
- System preference detection
- Manual theme toggle
- Persistent theme selection

### Responsive Design

TMA Cloud features **dedicated mobile and desktop UI/UX** that are completely separate, ensuring optimal experience on all devices.

#### Mobile/Responsive UI (≤ 1024px)

- **Dedicated Mobile Layout**: Completely separate UI optimized for mobile and tablet devices
- **Bottom Navigation Bar**: Easy thumb-reach navigation with Home, Files, Shared, Starred, Trash, and Settings
- **Compact Header**: Streamlined top bar with app logo, current section, upload button, and user profile
- **Mobile-Optimized File Manager**:
  - Truncated breadcrumbs with ellipsis for deep folder navigation
  - Text wrapping in grid view to prevent overflow
  - Compact spacing and touch-friendly controls
  - Action buttons always visible and accessible
- **Mobile Context Menu**:
  - Bottom sheet action menu (Google Drive-like)
  - Press-and-hold (500ms) to open context menu
  - Large, thumb-friendly action buttons
  - Swipe down to dismiss
- **Mobile Image Viewer**:
  - Full-screen immersive experience
  - Pinch-to-zoom (0.5x - 5x)
  - Swipe left/right to navigate between images
  - Swipe down to dismiss
  - Tap to toggle controls visibility
  - Auto-hide controls after 3 seconds
  - Double-tap to zoom in/out
  - Image counter for multiple images
  - Smooth animations and transitions

#### Desktop UI (> 1024px)

- **Traditional Desktop Layout**: Sidebar navigation with header bar
- **Desktop Image Viewer**:
  - Modal-based viewer
  - Fit-to-screen by default (images automatically fit viewport)
  - Mouse wheel zoom
  - Click and drag to pan
  - Double-click to reset zoom
  - Zoom controls in bottom-right corner
- **Desktop Context Menu**: Right-click context menu with all file actions
- **Full Feature Access**: All features optimized for mouse and keyboard interaction

#### Viewport Detection

- Automatic detection of viewport size
- Seamless switching between mobile and desktop UI
- No conflicts between mobile and desktop implementations
- Each UI is completely isolated and optimized for its platform

### Accessibility

- Keyboard navigation
- Screen reader support
- Semantic HTML
- ARIA labels

## Security Features

### Authentication Security

- JWT token expiration
- HttpOnly cookies
- Secure password hashing (bcrypt with salt rounds)
- CSRF protection
- Rate limiting on authentication endpoints (5 attempts per 15 minutes)
- Input validation and sanitization for all user inputs
- Email format validation
- Password strength requirements
- Complete audit trail of authentication events

### Logging Security

- **Secret Masking**: Automatic redaction of sensitive data in logs
  - JWT tokens partially masked
  - Passwords fully redacted
  - Cookies values masked
  - Authorization headers masked
  - API keys and OAuth secrets protected
- **Structured Logging**: JSON-formatted logs prevent log injection attacks
- **Audit Trail**: Complete tracking of all critical operations
- **IP Tracking**: All actions logged with source IP address

### File Security

- User-based access control
- Share link token security (validated format)
- File path validation (prevents directory traversal attacks)
- Storage isolation per user
- File name validation (prevents path traversal, null bytes, reserved characters)
- Executable file handling (forced download, not inline execution)
- MIME type spoofing detection

### API Security

- **Single-Origin Architecture**: Frontend and backend on same domain (no CORS needed)
- **Security Headers**: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, CSP, Referrer-Policy
- **Comprehensive Input Validation**: All endpoints validate and sanitize user input
- **Error Message Sanitization**: Generic error messages prevent information leakage
- **Rate Limiting** (when enabled):
  - Authentication endpoints: 5 requests per 15 minutes
  - General API endpoints: 100 requests per 15 minutes
  - File upload endpoints: 50 uploads per hour
- **SQL Injection Prevention**: All queries use parameterized statements
- **XSS Prevention**: HTML escaping for user-generated content
- **CSRF Protection**: SameSite cookie attributes and origin validation

### Input Validation

All user inputs are validated and sanitized:

- **IDs**: Validated against expected format (8-16 character alphanumeric)
- **File/Folder Names**: Validated to prevent path traversal, null bytes, and reserved characters
- **Search Queries**: Sanitized and length-limited
- **Email Addresses**: Format validation and length limits
- **Sort Parameters**: Whitelist-based validation
- **Share Tokens**: Format validation (8 character alphanumeric)
- **File Uploads**: Filename validation, MIME type checking

### SQL Injection Protection

- All database queries use parameterized statements
- No string concatenation in SQL queries
- Sort fields validated against whitelist
- Search queries properly parameterized

### XSS (Cross-Site Scripting) Protection

- HTML escaping for all user-generated content in shared file listings
- Content-Type headers with nosniff for executable files
- Proper Content-Disposition headers for downloads

### SSRF (Server-Side Request Forgery) Protection

- URL validation in OnlyOffice callbacks
- Blocking of localhost and private IP ranges (IPv4 and IPv6)
- Protocol validation (only HTTP/HTTPS allowed)

### Rate Limiting

Rate limiting is implemented to prevent brute force attacks and abuse:

- **Authentication Endpoints** (`/api/signup`, `/api/login`): 5 attempts per 15 minutes per IP/email
- **General API Endpoints**: 100 requests per 15 minutes per IP
- **File Upload Endpoints**: 50 uploads per hour per user/IP

Rate limit violations return HTTP 429 (Too Many Requests).

## Performance

### Optimizations

- Lazy loading of components
- Debounced search
- Optimistic UI updates
- Efficient file listing
- Cached API responses

### Scalability

- Database indexing
- Efficient queries
- Background processing
- Resource cleanup

## Error Handling

### User-Friendly Errors

- Clear error messages
- Toast notifications
- Retry mechanisms
- Graceful degradation

### Error Types

- Validation errors
- Authentication errors
- Storage errors
- Network errors
- Server errors

## Notifications

### Toast System

- Success notifications
- Error notifications
- Warning messages
- Info messages
- Auto-dismiss

## Image Viewing

### Desktop Image Viewer

- **Modal-based viewer** with clean interface
- **Fit-to-screen by default**: Images automatically scale to fit viewport on open
- **Mouse wheel zoom**: Scroll to zoom in/out (0.25x - 5x)
- **Click and drag**: Pan around zoomed images
- **Double-click**: Reset zoom to fit-to-screen
- **Zoom controls**: Bottom-right corner with zoom percentage display
- **Smooth interactions**: Optimized for mouse and keyboard

### Mobile Image Viewer

- **Full-screen immersive experience**: Google Drive-like interface
- **Pinch-to-zoom**: Two-finger pinch gesture (0.5x - 5x)
- **Swipe navigation**: Swipe left/right to navigate between images in folder
- **Swipe down to dismiss**: Natural gesture to close viewer
- **Tap to toggle controls**: Tap anywhere to show/hide UI controls
- **Auto-hide controls**: Controls automatically hide after 3 seconds when zoomed out
- **Double-tap zoom**: Double-tap to zoom to 2x, double-tap again to reset
- **Image counter**: Shows current image position (e.g., "2 / 5")
- **Navigation arrows**: Previous/next buttons when multiple images available
- **Smooth animations**: Polished transitions and interactions

## File Types

### Supported Types

- Documents (PDF, DOCX, XLSX, PPTX)
- Images (JPG, PNG, GIF, SVG, etc.)
- Archives (ZIP, RAR, etc.)
- Text files
- Code files
- Any file type

### File Icons

- Automatic icon selection based on type
- Folder icons
- File type indicators
- Visual file identification

## Limitations

### Current Limitations

- Single server deployment
- Local file storage
- No real-time collaboration (without OnlyOffice)
- No file versioning (basic)
- Limited file preview types

### Future Enhancements

- Object storage integration
- Advanced versioning
- Real-time collaboration
- File comments
- Advanced permissions
- Native mobile apps (iOS/Android)
