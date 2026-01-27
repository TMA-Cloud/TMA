# Users API

User management endpoints for TMA Cloud.

**Note:** All endpoints in this section are rate-limited to 100 requests per 15 minutes per IP address. Most also require admin privileges (first user).

## List Users

### GET `/api/user/all`

List all users (admin only).

**Response:**

An object containing an array of all user objects.

```json
{
  "users": [
    {
      "id": "user_123",
      "email": "user@example.com",
      "name": "User Name",
      "createdAt": "2024-01-01T00:00:00Z",
      "mfaEnabled": false,
      "storageUsed": 1073741824,
      "storageLimit": 107374182400,
      "storageTotal": 107374182400,
      "actualDiskSize": 1099511627776
    }
  ]
}
```

## Storage

### GET `/api/user/storage`

Get storage usage information for the authenticated user.

**Response:**

```json
{
  "used": 1073741824,
  "total": 107374182400,
  "free": 106300440576
}
```

### PUT `/api/user/storage-limit`

Update a user's storage limit (admin only).

**Request Body:**

```json
{
  "targetUserId": "user_123",
  "storageLimit": 107374182400
}
```

**Validation:**

- `targetUserId`: Required. Must be a string.
- `storageLimit`: Optional. Must be a positive integer or `null` to reset to the default limit.

**Response:**

```json
{
  "storageLimit": 107374182400
}
```

## Signup Status

### GET `/api/user/signup-status`

Get the current user signup status and whether the current user is allowed to toggle it.

**Response:**

```json
{
  "signupEnabled": true,
  "canToggle": true
}
```

### POST `/api/user/signup-toggle`

Enable or disable public user signup (admin only).

**Request Body:**

```json
{
  "enabled": true
}
```

**Validation:**

- `enabled`: Required. Must be a boolean.

**Response:**

```json
{
  "signupEnabled": true
}
```

## Custom Drive

### GET `/api/user/custom-drive`

Get custom drive settings for a user.

**Query Parameters:**

- `targetUserId` - Target user ID (optional, admin only). If not provided, returns settings for the current user.

**Validation:**

- `targetUserId`: Optional. Must be a string.

**Response:**

```json
{
  "enabled": false,
  "path": null,
  "ignorePatterns": []
}
```

### GET `/api/user/custom-drive/all`

Get custom drive settings for all users (admin only).

**Response:**

```json
{
  "users": [
    {
      "id": "user_123",
      "email": "user@example.com",
      "name": "User Name",
      "createdAt": "2024-01-01T00:00:00Z",
      "customDrive": {
        "enabled": true,
        "path": "/custom/path",
        "ignorePatterns": [".git", "node_modules", ".env"]
      }
    }
  ]
}
```

### PUT `/api/user/custom-drive`

Update custom drive settings for a user (admin only).

**Request Body:**

```json
{
  "enabled": true,
  "path": "/data/custom_drive",
  "targetUserId": "user_id",
  "ignorePatterns": [".git", "node_modules"]
}
```

**Validation:**

- `enabled`: Optional. Must be a boolean.
- `path`: Optional. Must be a string representing a valid path.
- `targetUserId`: Optional. Must be a string.
- `ignorePatterns`: Optional. Must be an array of strings.

**Response:**

The updated custom drive settings for the target user.

```json
{
  "enabled": true,
  "path": "/data/custom_drive",
  "ignorePatterns": [".git", "node_modules"]
}
```

## OnlyOffice Configuration

### GET `/api/user/onlyoffice-configured`

Check if OnlyOffice is configured on the server. This endpoint is accessible to all authenticated users and only indicates if the integration is active.

**Response:**

```json
{
  "configured": true
}
```

### GET `/api/user/onlyoffice-config`

Get the current OnlyOffice configuration (admin only). This does not expose the JWT secret.

**Response:**

```json
{
  "jwtSecretSet": true,
  "url": "https://onlyoffice.example.com"
}
```

### PUT `/api/user/onlyoffice-config`

Update the OnlyOffice configuration (admin only).

**Request Body:**

```json
{
  "jwtSecret": "your_jwt_secret",
  "url": "https://onlyoffice.example.com"
}
```

**Validation:**

- `jwtSecret`: Optional. Must be a string.
- `url`: Optional. Must be a valid URL.

**Note:** Both `jwtSecret` and `url` must be provided together, or both must be empty/null to disable the integration.

**Response:**

The updated OnlyOffice configuration status.

```json
{
  "jwtSecretSet": true,
  "url": "https://onlyoffice.example.com"
}
```

## Agent Configuration

### GET `/api/user/agent-config`

Get the agent configuration (admin only).

**Response:**

```json
{
  "tokenSet": true,
  "url": "http://host.docker.internal:8080"
}
```

### PUT `/api/user/agent-config`

Update the agent configuration (admin only).

**Request Body:**

```json
{
  "url": "http://host.docker.internal:8080",
  "token": "agent_token_here"
}
```

**Validation:**

- `token`: Optional. Must be a string.
- `url`: Optional. Must be a valid URL.

**Note:** Both `url` and `token` can be set to `null` to clear the configuration.

**Response:**

The updated agent configuration status.

```json
{
  "tokenSet": true,
  "url": "http://host.docker.internal:8080"
}
```

## Share Base URL Configuration

### GET `/api/user/share-base-url-config`

Get the share base URL configuration (admin only).

**Response:**

```json
{
  "url": "https://share.example.com"
}
```

### PUT `/api/user/share-base-url-config`

Update the share base URL configuration (admin only).

**Request Body:**

```json
{
  "url": "https://share.example.com"
}
```

**Validation:**

- `url`: Optional. Must be a valid URL.

**Note:** Set `url` to `null` to clear the configuration and use the request origin instead.

**Response:**

The updated share base URL configuration.

```json
{
  "url": "https://share.example.com"
}
```

### GET `/api/user/agent-paths`

Get configured paths from the agent (admin only).

**Response:**

```json
{
  "paths": ["/mnt/storage", "/data/drive"]
}
```

### GET `/api/user/agent-status`

Check the agent's connection status (admin only).

**Response:**

```json
{
  "isOnline": true
}
```

## Related Topics

- [Admin Guides](/guides/admin/user-management) - User management
- [Storage Management](/concepts/storage-management) - Storage concepts
