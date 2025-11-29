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

1. Create Google OAuth credentials
2. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
3. Enable in application

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
2. Configure `ONLYOFFICE_JWT_SECRET` and `BACKEND_URL`
3. Set `ONLYOFFICE_JS_URL` in frontend
4. Enable integration

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
- Permanent deletion
- Automatic cleanup after 30 days

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
- Deletes files from trash after 30 days
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

1. Set `CUSTOM_DRIVE=yes`
2. Configure `CUSTOM_DRIVE_PATH` to external directory
3. Service automatically syncs files

### Audit Worker

Queue-based audit event processing:

- Processes audit events asynchronously
- Writes to `audit_logs` database table
- Configurable concurrency
- Automatic retry on failure
- Runs as separate process

**Setup:**

```bash
npm run worker
```

## Logging and Monitoring

### Structured Logging

TMA Cloud uses **Pino** for high-performance structured logging:

**Features:**

- **JSON Logs**: Structured logs for easy parsing and analysis
- **Pretty Printing**: Human-readable logs for development
- **Multiple Log Levels**: fatal, error, warn, info, debug, trace
- **Request Logging**: Automatic HTTP request/response logging
- **Context Propagation**: Request ID and user ID tracked across logs

**Configuration:**

```bash
# Log level (debug recommended for development)
LOG_LEVEL=debug

# Log format (pretty for development, json for production)
LOG_FORMAT=pretty
```

**Example Log Output:**

```json
{
  "level": 30,
  "time": 1679251200000,
  "requestId": "abc123",
  "userId": "user_001",
  "msg": "File uploaded successfully",
  "fileName": "document.pdf",
  "fileSize": 1024000
}
```

See [Logging Documentation](logging.md) for details.

### Secret Masking

Automatic redaction of sensitive data in logs:

**Masked Data:**

- JWT tokens (partial masking: `eyJh...***...mVw`)
- Passwords (fully redacted: `[REDACTED]`)
- Cookies (values masked, options preserved)
- Authorization headers (Bearer tokens masked)
- API keys and secrets (partial masking)
- OAuth tokens and secrets

**Why It Matters:**

- Prevents credential leakage in logs
- Safe to use debug logging in production
- Compliance with security best practices
- Protects user privacy

**Example:**

```javascript
// Request with Authorization header
Authorization: Bearer eyJhbGci...long_token...XVCmVw

// Logged as:
Authorization: Bearer eyJhbGci...***...mVw
```

### Audit Trail

Comprehensive audit logging system tracks all critical actions:

**Tracked Events:**

- **Authentication**: Login, logout, signup, failures
- **File Operations**: Upload, download, delete, move, copy, rename, star
- **Folder Operations**: Create, delete, move, copy
- **Share Operations**: Create, delete, access
- **Document Operations**: Open, save (OnlyOffice)
- **Settings**: Configuration changes

**Audit Log Contents:**

- Event type and timestamp
- User who performed action
- IP address and user agent
- Resource type and ID (file, folder, share)
- Status (success/failure)
- Rich metadata (file names, sizes, types, destinations)

**Example Audit Entry:**

```json
{
  "id": 1234,
  "event_type": "file.upload",
  "user_id": "user_abc123",
  "status": "success",
  "resource_type": "file",
  "resource_id": "file_xyz789",
  "ip_address": "192.168.1.100",
  "metadata": {
    "fileName": "report.pdf",
    "fileSize": 2048000,
    "mimeType": "application/pdf"
  },
  "created_at": "2025-01-15T14:30:00Z"
}
```

**Query Audit Logs:**

```sql
-- View user activity
SELECT * FROM audit_logs
WHERE user_id = 'user_123'
ORDER BY created_at DESC;

-- View failed operations
SELECT * FROM audit_logs
WHERE status = 'failure'
ORDER BY created_at DESC;

-- View file operations
SELECT * FROM audit_logs
WHERE event_type LIKE 'file.%'
ORDER BY created_at DESC;
```

**Benefits:**

- Complete user activity tracking
- Security incident investigation
- Compliance (GDPR, HIPAA, SOC 2)
- User behavior analysis
- Debugging and troubleshooting

See [Audit Documentation](audit.md) for details.

### Application Metrics

Monitor application health via metrics endpoint:

**Endpoint:** `GET /metrics`

**Access Control:** Restricted by IP address (see `METRICS_ALLOWED_IPS`)

**Available Metrics:**

- Application uptime
- Memory usage
- CPU usage
- Request statistics
- Error rates

**Configuration:**

```bash
# Allow specific IPs to access metrics
METRICS_ALLOWED_IPS=127.0.0.1,::1,10.0.0.5
```

## User Interface

### Themes

- Light mode
- Dark mode
- System preference detection
- Manual theme toggle
- Persistent theme selection

### Responsive Design

- Mobile-friendly layouts
- Tablet optimization
- Desktop experience
- Adaptive components

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
- Mobile apps
