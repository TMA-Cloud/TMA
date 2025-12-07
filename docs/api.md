# API Documentation

Complete API reference for TMA Cloud backend endpoints.

## Base URL

All API endpoints are prefixed with `/api` unless otherwise specified.

## Endpoints

### Authentication

Most endpoints require authentication via JWT token. The token is sent as an httpOnly cookie automatically by the browser.

**Rate Limiting:** Authentication endpoints (`/api/signup`, `/api/login`) are rate-limited to 5 attempts per 15 minutes per IP address and email combination.

### Headers

```bash
Cookie: token=<jwt_token>
```

### Security

All API endpoints implement comprehensive security measures:

- **Input Validation**: All inputs are validated and sanitized
- **Rate Limiting**: Endpoints are rate-limited to prevent abuse
- **SQL Injection Protection**: All queries use parameterized statements
- **XSS Protection**: User-generated content is properly escaped
- **Path Traversal Protection**: File paths are validated to prevent directory traversal
- **Audit Logging**: All critical operations automatically logged to audit trail
- **Structured Logging**: All requests logged with automatic secret masking (JWTs, passwords, cookies)

#### POST `/api/signup`

Create a new user account.

**Note:** This endpoint respects the signup enabled/disabled setting. If signup is disabled, returns 403 Forbidden.

**Audit Logging:** Creates `user.signup` audit event (success or failure).

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securepassword",
  "name": "User Name"
}
```

**Response (Success):**

```json
{
  "success": true,
  "message": "User created successfully",
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

**Response (Signup Disabled):**

```json
{
  "message": "Signup is currently disabled"
}
```

**Status Codes:**

- `200` - User created successfully
- `400` - Invalid input (email/password validation)
- `403` - Signup is currently disabled
- `409` - Email already in use
- `500` - Server error

#### POST `/api/login`

Authenticate user and receive JWT token.

**Audit Logging:** Creates `user.login` audit event (success) or `user.login.failed` audit event (failure).

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Login successful",
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

#### POST `/api/logout`

Log out current user (clears token cookie).

**Audit Logging:** Creates `user.logout` audit event.

**Response:**

```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

#### GET `/api/profile`

Get current user profile.

**Headers:** Requires authentication

**Response:**

```json
{
  "success": true,
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "User Name",
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

#### GET `/api/google/enabled`

Check if Google OAuth is enabled.

**Response:**

```json
{
  "enabled": true
}
```

#### GET `/api/google/login`

Initiate Google OAuth login (redirects to Google).

#### GET `/api/google/callback`

Google OAuth callback endpoint.

**Note:** If signup is disabled and the user doesn't exist, redirects to frontend with `?error=signup_disabled`.

---

### File Management

All file endpoints require authentication.

#### GET `/api/files`

List files and folders in a directory.

**Query Parameters:**

- `parentId` (optional): Parent folder ID (default: null for root)
- `sortBy` (optional): Sort field (`name`, `created_at`, `updated_at`, `size`, `type`)
- `order` (optional): Sort order (`asc`, `desc`)

**Response:**

```json
{
  "success": true,
  "files": [
    {
      "id": "file_id",
      "name": "document.pdf",
      "type": "file",
      "size": 1024,
      "mime_type": "application/pdf",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z",
      "parent_id": "parent_id",
      "path": "/folder/document.pdf"
    }
  ]
}
```

#### GET `/api/files/stats`

Get file statistics (total files, total size, etc.).

**Response:**

```json
{
  "success": true,
  "stats": {
    "total_files": 100,
    "total_folders": 10,
    "total_size": 1048576
  }
}
```

#### GET `/api/files/search`

Search for files and folders.

**Query Parameters:**

- `q` or `query`: Search query string (required)
- `limit` (optional): Maximum number of results (default: 100)

**Response:**

```json
{
  "success": true,
  "files": [...]
}
```

#### POST `/api/files/folder`

Create a new folder.

**Request Body:**

```json
{
  "name": "New Folder",
  "parent_id": "parent_id" // optional, null for root
}
```

**Response:**

```json
{
  "success": true,
  "file": {
    "id": "folder_id",
    "name": "New Folder",
    "type": "folder"
  }
}
```

#### POST `/api/files/upload`

Upload a file.

**Request:** Multipart form data

- `file`: File to upload
- `parent_id` (optional): Parent folder ID
- `path` (optional): Target path

**Response:**

```json
{
  "success": true,
  "file": {
    "id": "file_id",
    "name": "uploaded.pdf",
    "type": "file",
    "size": 1024
  }
}
```

#### POST `/api/files/move`

Move files or folders.

**Request Body:**

```json
{
  "ids": ["id1", "id2"],
  "parentId": "target_folder_id" // optional, null for root
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files moved successfully"
}
```

#### POST `/api/files/copy`

Copy files or folders.

**Request Body:**

```json
{
  "ids": ["id1", "id2"],
  "parentId": "target_folder_id" // optional, null for root
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files copied successfully"
}
```

#### POST `/api/files/rename`

Rename a file or folder.

**Request Body:**

```json
{
  "id": "file_id",
  "name": "New Name"
}
```

**Response:**

```json
{
  "success": true,
  "file": {
    "id": "file_id",
    "name": "New Name"
  }
}
```

#### POST `/api/files/star`

Star/unstar files.

**Request Body:**

```json
{
  "ids": ["id1", "id2"],
  "starred": true
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files starred successfully"
}
```

#### GET `/api/files/starred`

List all starred files.

**Query Parameters:**

- `sortBy` (optional): Sort field (`name`, `created_at`, `updated_at`, `size`, `type`)
- `order` (optional): Sort order (`asc`, `desc`)

**Response:**

```json
{
  "success": true,
  "files": [...]
}
```

#### POST `/api/files/share`

Share or unshare files/folders.

**Request Body:**

```json
{
  "ids": ["id1", "id2"],
  "shared": true // true to share, false to unshare
}
```

**Response:**

```json
{
  "success": true,
  "links": {
    "id1": "share_token_1",
    "id2": "share_token_2"
  }
}
```

**Note:** When sharing, creates or reuses share links. When unsharing (`shared: false`), removes files from share links.

#### GET `/api/files/shared`

List files shared by current user.

**Query Parameters:**

- `sortBy` (optional): Sort field (`name`, `created_at`, `updated_at`, `size`, `type`)
- `order` (optional): Sort order (`asc`, `desc`)

**Response:**

```json
{
  "success": true,
  "files": [...]
}
```

#### POST `/api/files/link-parent-share`

Link files to their parent folder's share link.

**Request Body:**

```json
{
  "ids": ["id1", "id2"]
}
```

**Response:**

```json
{
  "success": true,
  "links": {
    "id1": "parent_share_token",
    "id2": "parent_share_token"
  }
}
```

**Note:** Adds files to their parent folder's existing share link if one exists.

#### POST `/api/files/delete`

Move files to trash.

**Request Body:**

```json
{
  "ids": ["id1", "id2"]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files moved to trash"
}
```

#### GET `/api/files/trash`

List files in trash.

**Query Parameters:**

- `sortBy` (optional): Sort field (`name`, `created_at`, `updated_at`, `size`, `type`)
- `order` (optional): Sort order (`asc`, `desc`)

**Response:**

```json
{
  "success": true,
  "files": [...]
}
```

#### POST `/api/files/trash/restore`

Restore files from trash to their original location.

**Request Body:**

```json
{
  "ids": ["id1", "id2"]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Restored 2 file(s) from trash"
}
```

**Behavior:**

- Restores files to their original parent folder if it still exists
- If the original parent folder was deleted, files are restored to the root directory
- Automatically handles name conflicts by renaming restored files (e.g., "file (1).txt")
- Recursively restores all children of selected folders
- All operations are performed in a transaction (all-or-nothing)

**Status Codes:**

- `200` - Files restored successfully
- `400` - Invalid ids array
- `404` - No files found in trash to restore
- `500` - Server error

#### POST `/api/files/trash/delete`

Permanently delete files from trash.

**Request Body:**

```json
{
  "ids": ["id1", "id2"]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files deleted permanently"
}
```

#### GET `/api/files/:id/download`

Download a file or folder.

**Parameters:**

- `id` (path): File or folder ID

**Response:**

- For files: File stream with appropriate Content-Type and Content-Disposition headers
- For folders: ZIP archive stream with `application/zip` Content-Type

**Headers:**

- `Content-Type`: MIME type of the file (for files) or `application/zip` (for folders)
- `Content-Disposition`: `attachment; filename="filename.ext"; filename*=UTF-8''encoded_filename`
  - Uses RFC 5987 encoding for filenames with special characters
  - For folders, the filename will be `foldername.zip`

**Behavior:**

- **Files**: Downloads directly with original filename and extension preserved
- **Folders**: Automatically zipped before download with `.zip` extension added
- Concurrent download requests for the same user are prevented using mutex locks
- Deleted files/folders cannot be downloaded (returns 404)

**Status Codes:**

- `200` - Download successful
- `400` - Invalid file ID
- `404` - File/folder not found or deleted
- `500` - Server error

**Example:**

```bash
# Download a file
GET /api/files/abc123def/download

# Download a folder (returns ZIP)
GET /api/files/xyz789ghi/download
```

---

### User

#### GET `/api/user/storage`

Get storage usage information.

**Response:**

```json
{
  "success": true,
  "used": 1048576,
  "total": 1073741824,
  "free": 1072693248
}
```

**Note:**

- If custom drive is enabled, returns actual disk space from the custom drive path
- Otherwise, returns user storage usage with storage limit

#### GET `/api/user/signup-status`

Get current signup status and whether the current user can toggle it.

**Headers:** Requires authentication

**Response:**

```json
{
  "success": true,
  "signupEnabled": false,
  "canToggle": true
}
```

**Response Fields:**

- `signupEnabled` (boolean): Whether new user registration is currently enabled
- `canToggle` (boolean): Whether the current user has permission to toggle signup (only true for first user)

#### POST `/api/user/signup-toggle`

Enable or disable user signup. Only the first user can perform this action.

**Headers:** Requires authentication

**Audit Logging:** Creates `settings.signup.toggle` audit event with new status.

**Request Body:**

```json
{
  "enabled": true
}
```

**Response:**

```json
{
  "success": true,
  "signupEnabled": true
}
```

**Status Codes:**

- `200` - Signup status updated successfully
- `400` - Invalid request (enabled must be boolean)
- `403` - Only the first user can toggle signup
- `500` - Server error

**Security Notes:**

- Only the first user (oldest account by creation date) can toggle signup
- The first user ID is immutable once set
- All operations use database transactions for atomicity
- Unauthorized attempts are logged

---

### OnlyOffice

#### GET `/api/onlyoffice/config/:id`

Get OnlyOffice editor configuration for a file.

**Response:**

```json
{
  "document": {
    "fileType": "pdf",
    "key": "file_key",
    "title": "document.pdf",
    "url": "https://example.com/api/onlyoffice/file/:id?token=..."
  },
  "documentType": "text",
  "editorConfig": {
    "mode": "edit",
    "callbackUrl": "https://example.com/api/onlyoffice/callback"
  }
}
```

#### GET `/api/onlyoffice/viewer/:id`

Get standalone viewer page for a file.

**Response:** HTML page with OnlyOffice viewer embedded.

#### GET `/api/onlyoffice/file/:id`

Serve file to OnlyOffice server (requires signed token).

**Query Parameters:**

- `token`: Signed JWT token

**Response:** File stream

#### POST `/api/onlyoffice/callback`

OnlyOffice callback endpoint (called by OnlyOffice server).

---

### Share Links (Public)

These endpoints don't require authentication.

**Audit Logging:** All share link access is logged with `share.access` audit events including IP address, file accessed, and share token.

#### GET `/s/:token`

View shared files/folders.

**Response:** HTML page or JSON depending on Accept header.

#### GET `/s/:token/file/:id`

Download a file from a share link.

**Response:** File stream

#### GET `/s/:token/zip`

Download a folder as ZIP from a share link.

**Response:** ZIP file stream

---

### Monitoring

#### GET `/metrics`

Get application health and performance metrics.

**Access Control:** Restricted to IP addresses listed in `METRICS_ALLOWED_IPS` environment variable.

**Response:**

```json
{
  "uptime": 3600,
  "memory": {
    "rss": 123456789,
    "heapTotal": 98765432,
    "heapUsed": 87654321,
    "external": 1234567
  },
  "cpu": {
    "user": 1234567,
    "system": 234567
  }
}
```

**Response Fields:**

- `uptime` (number): Application uptime in seconds
- `memory` (object): Memory usage statistics in bytes
  - `rss`: Resident Set Size (total memory allocated)
  - `heapTotal`: Total heap size
  - `heapUsed`: Heap memory used
  - `external`: Memory used by C++ objects
- `cpu` (object): CPU usage in microseconds
  - `user`: User CPU time
  - `system`: System CPU time

**Status Codes:**

- `200` - Success
- `403` - Forbidden (IP not allowed)

**Security Notes:**

- Only accessible from IPs listed in `METRICS_ALLOWED_IPS` environment variable
- Default allowed IPs: `127.0.0.1` (localhost IPv4) and `::1` (localhost IPv6)
- Configure allowed IPs via environment: `METRICS_ALLOWED_IPS=127.0.0.1,::1`

**Example:**

```bash
# Only works from allowed IP
curl http://localhost:3000/metrics
```

---

## Audit Logging

**Note:** All API endpoints automatically log audit events for critical operations. Audit logging happens asynchronously in the background and does not affect API response times.

**Logged Events:**

- **Authentication**: signup, login, logout, failed login attempts
- **File Operations**: upload, download, delete, move, copy, rename, star/unstar
- **Folder Operations**: create
- **Share Operations**: create, delete, access via share links
- **Document Operations**: open, save (OnlyOffice)
- **Settings**: signup toggle

**Audit Log Data:**

Each audit event includes:

- Event type and timestamp
- User ID (if authenticated)
- IP address and user agent
- Resource type and ID (file, folder, share, etc.)
- Status (success/failure)
- Detailed metadata (file names, sizes, types, destinations, etc.)

**Accessing Audit Logs:**

Audit logs are stored in the `audit_logs` PostgreSQL table. Access requires direct database queries. See [Audit Documentation](audit.md) for query examples.

**Privacy:**

- Sensitive data (passwords, tokens) is never logged
- IP addresses are logged for security auditing
- User agents are logged for troubleshooting

---

## Error Responses

All endpoints return errors in the following format:

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE" // optional
}
```

### Common Error Codes

- `UNAUTHORIZED` - Authentication required
- `FORBIDDEN` - Insufficient permissions
- `NOT_FOUND` - Resource not found
- `VALIDATION_ERROR` - Invalid input
- `STORAGE_LIMIT_EXCEEDED` - Storage quota exceeded
- `FILE_NOT_FOUND` - File doesn't exist
- `DUPLICATE_NAME` - File/folder name already exists

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error
