# Users API

User management endpoints for TMA Cloud (admin only).

## Storage

### GET `/api/user/storage`

Get storage usage information.

**Response:**

```json
{
  "success": true,
  "data": {
    "used": 1073741824,
    "limit": 107374182400,
    "percentage": 1.0
  }
}
```

## Signup Status

### GET `/api/user/signup-status`

Get signup status and whether current user can toggle it.

**Response:**

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "canToggle": true
  }
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
  "success": true,
  "message": "Signup enabled"
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
  "success": true,
  "data": {
    "enabled": false,
    "path": null
  }
}
```

### GET `/api/user/custom-drive/all`

Get custom drive settings for all users (admin only).

**Response:**

```json
{
  "success": true,
  "data": {
    "users": [
      {
        "userId": "user_123",
        "enabled": true,
        "path": "/custom/path"
      }
    ]
  }
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
  "success": true,
  "message": "Custom drive updated"
}
```

## Related Topics

- [Admin Guides](/guides/admin/user-management) - User management
- [Storage Management](/concepts/storage-management) - Storage concepts
