# API Documentation

Complete API reference for TMA Cloud backend endpoints.

## Base URL

All API endpoints are prefixed with `/api` unless otherwise specified.

## Endpoints

### Authentication

Most endpoints require authentication via JWT token. The token is sent as an httpOnly cookie automatically by the browser.

### Headers

```bash
Cookie: token=<jwt_token>
```

#### POST `/api/signup`

Create a new user account.

**Note:** This endpoint respects the signup enabled/disabled setting. If signup is disabled, returns 403 Forbidden.

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

Download a file.

**Response:** File stream with appropriate Content-Type header.

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
