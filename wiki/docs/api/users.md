# Users API

User management endpoints for TMA Cloud (admin only).

**Note:** Most endpoints require admin privileges (first user). Some endpoints are available to all authenticated users.

## List Users

### GET `/api/user/all`

List all users (admin only).

**Response:**

```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "user_123",
        "email": "user@example.com",
        "name": "User Name",
        "createdAt": "2024-01-01T00:00:00Z"
      }
    ]
  }
}
```

## Storage

### GET `/api/user/storage`

Get storage usage information.

**Response:**

```json
{
  "used": 1073741824,
  "total": 107374182400,
  "free": 106300440576
}
```

## Signup Status

### GET `/api/user/signup-status`

Get signup status and whether current user can toggle it.

**Response:**

```json
{
  "signupEnabled": true,
  "canToggle": true
}
```

### POST `/api/user/signup-toggle`

Enable/disable user signup (first user only).

**Request Body:**

```json
{
  "enabled": true
}
```

**Response:**

```json
{
  "signupEnabled": true
}
```

## Custom Drive

### GET `/api/user/custom-drive`

Get custom drive settings.

**Query Parameters:**

- `targetUserId` - Target user ID (optional, admin only)

**Response:**

```json
{
  "enabled": false,
  "path": null
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
        "path": "/custom/path"
      }
    }
  ]
}
```

### PUT `/api/user/custom-drive`

Update custom drive settings (admin only).

**Request Body:**

```json
{
  "enabled": true,
  "path": "/data/custom_drive",
  "targetUserId": "user_id"
}
```

**Response:**

```json
{
  "enabled": true,
  "path": "/data/custom_drive"
}
```

## OnlyOffice Configuration

### GET `/api/user/onlyoffice-configured`

Check if OnlyOffice is configured (all authenticated users). Returns only whether it's configured, not the actual secrets.

**Response:**

```json
{
  "configured": true
}
```

### GET `/api/user/onlyoffice-config`

Get OnlyOffice configuration (admin only). Returns configuration details without exposing sensitive secrets.

**Response:**

```json
{
  "success": true,
  "data": {
    "jwtSecretSet": true,
    "url": "https://onlyoffice.example.com"
  }
}
```

### PUT `/api/user/onlyoffice-config`

Update OnlyOffice configuration (admin only).

**Request Body:**

```json
{
  "jwtSecret": "your_jwt_secret",
  "url": "https://onlyoffice.example.com"
}
```

**Response:**

```json
{
  "jwtSecretSet": true,
  "url": "https://onlyoffice.example.com"
}
```

**Note:** Both `jwtSecret` and `url` must be provided together, or both must be empty/null to disable OnlyOffice integration.

## Related Topics

- [Admin Guides](/guides/admin/user-management) - User management
- [Storage Management](/concepts/storage-management) - Storage concepts
