# API Documentation

REST API reference for TMA Cloud backend.

## Base URL

All API endpoints are prefixed with `/api` unless otherwise specified.

## Authentication

Most endpoints require JWT token sent as httpOnly cookie. Rate limiting: 5 attempts per 15 minutes for auth endpoints.

## Endpoints

### Authentication Endpoints

#### POST `/api/signup`

Create new user account. Respects signup enabled/disabled setting.

#### POST `/api/login`

Authenticate user and receive JWT token. If MFA is enabled, requires `mfaCode` in request.

#### POST `/api/logout`

Log out current user (clears token cookie).

#### POST `/api/logout-all`

Log out from all devices by invalidating all tokens.

#### GET `/api/sessions`

Get all active sessions for authenticated user.

#### DELETE `/api/sessions/:sessionId`

Revoke a specific session.

#### POST `/api/sessions/revoke-others`

Revoke all other active sessions except the current one.

#### GET `/api/profile`

Get current user profile.

#### GET `/api/google/enabled`

Check if Google OAuth is enabled.

#### GET `/api/google/login`

Initiate Google OAuth login (redirects to Google).

#### GET `/api/google/callback`

Google OAuth callback endpoint.

### Multi-Factor Authentication

#### GET `/api/mfa/status`

Get MFA status for current user.

#### POST `/api/mfa/setup`

Generate MFA secret and QR code for setup.

#### POST `/api/mfa/verify`

Verify MFA code and enable MFA.

#### POST `/api/mfa/disable`

Disable MFA. Requires verification code.

### File Management

#### GET `/api/files`

List files and folders. Query: `parentId`, `sortBy`, `order`.

#### GET `/api/files/stats`

Get file statistics (total files, total size).

#### GET `/api/files/search`

Search files. Query: `q` or `query` (required), `limit` (optional).

#### POST `/api/files/folder`

Create folder. Body: `{ "name": "New Folder", "parent_id": "parent_id" }`

#### POST `/api/files/upload`

Upload file. Multipart form: `file`, `parent_id` (optional), `path` (optional).

#### POST `/api/files/move`

Move files/folders. Body: `{ "ids": ["id1", "id2"], "parentId": "target_folder_id" }`

#### POST `/api/files/copy`

Copy files/folders. Body: `{ "ids": ["id1", "id2"], "parentId": "target_folder_id" }`

#### POST `/api/files/rename`

Rename file/folder. Body: `{ "id": "file_id", "name": "New Name" }`

#### POST `/api/files/star`

Star/unstar files. Body: `{ "ids": ["id1", "id2"], "starred": true }`

#### GET `/api/files/starred`

List starred files. Query: `sortBy`, `order`.

#### POST `/api/files/share`

Share/unshare files. Body: `{ "ids": ["id1", "id2"], "shared": true }`

#### GET `/api/files/shared`

List files shared by current user. Query: `sortBy`, `order`.

#### POST `/api/files/link-parent-share`

Link files to parent folder's share link. Body: `{ "ids": ["id1", "id2"] }`

#### POST `/api/files/delete`

Move files to trash. Body: `{ "ids": ["id1", "id2"] }`

#### GET `/api/files/trash`

List files in trash. Query: `sortBy`, `order`.

#### POST `/api/files/trash/restore`

Restore files from trash. Body: `{ "ids": ["id1", "id2"] }`

#### POST `/api/files/trash/delete`

Permanently delete files. Body: `{ "ids": ["id1", "id2"] }`

#### GET `/api/files/:id/download`

Download file or folder (folders return ZIP).

#### GET `/api/files/events`

Real-time file events stream (Server-Sent Events). Requires Redis.

### User

#### GET `/api/user/storage`

Get storage usage information.

#### GET `/api/user/signup-status`

Get signup status and whether current user can toggle it.

#### POST `/api/user/signup-toggle`

Enable/disable user signup (first user only). Body: `{ "enabled": true }`

#### GET `/api/user/custom-drive`

Get custom drive settings. Query: `targetUserId` (optional, admin only).

#### GET `/api/user/custom-drive/all`

Get custom drive settings for all users (admin only).

#### PUT `/api/user/custom-drive`

Update custom drive settings (admin only). Body: `{ "enabled": true, "path": "/data/custom_drive", "targetUserId": "user_id" }`

### OnlyOffice

#### GET `/api/onlyoffice/config/:id`

Get OnlyOffice editor configuration for a file.

#### GET `/api/onlyoffice/viewer/:id`

Get standalone viewer page for a file.

#### GET `/api/onlyoffice/file/:id`

Serve file to OnlyOffice server (requires signed token).

#### POST `/api/onlyoffice/callback`

OnlyOffice callback endpoint.

### Share Links (Public)

#### GET `/s/:token`

View shared files/folders.

#### GET `/s/:token/file/:id`

Download a file from a share link.

#### GET `/s/:token/zip`

Download a folder as ZIP from a share link.

### Version

#### GET `/api/version`

Get currently deployed backend version.

#### GET `/api/version/latest`

Fetch latest versions from update feed.

### Monitoring

#### GET `/metrics`

Get application health and performance metrics. Restricted to IPs in `METRICS_ALLOWED_IPS`.

## Error Responses

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

**Common Error Codes:** `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `STORAGE_LIMIT_EXCEEDED`

**HTTP Status Codes:** `200` - Success, `400` - Bad Request, `401` - Unauthorized, `403` - Forbidden, `404` - Not Found, `500` - Server Error
