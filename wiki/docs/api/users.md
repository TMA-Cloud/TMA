# Users API

User management endpoints for TMA Cloud.

**Note:** All endpoints in this section use the general API rate limit (1000 requests per 15 minutes per IP). Most also require admin privileges (first user).

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

- **Local:** `used`, `total`, `free` (total/free from disk and per-user limit).
- **S3:** `used`; `total` and `free` are per-user limit and (limit − used), or `null` when no limit (Unlimited).

```json
{
  "used": 1073741824,
  "total": 107374182400,
  "free": 106300440576
}
```

When S3 and no limit set: `total` and `free` may be `null` (Unlimited).

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

### GET `/api/signup-status`

Public endpoint. No authentication. Use to show or hide the signup link on the login page.

**Response:**

```json
{
  "signupEnabled": true
}
```

### GET `/api/user/signup-status`

Requires authentication. Returns signup status and whether the current user can toggle it. The first user (admin) also receives `totalUsers` and `additionalUsers`.

**Response (any authenticated user):**

```json
{
  "signupEnabled": true,
  "canToggle": false
}
```

**Response (first user / admin):**

```json
{
  "signupEnabled": true,
  "canToggle": true,
  "totalUsers": 3,
  "additionalUsers": 2
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

## Max Upload Size Configuration

### GET `/api/user/max-upload-size-config`

Get the current max upload size. Accessible to any authenticated user (used by the frontend for validation).

**Response:**

```json
{
  "maxBytes": 10737418240
}
```

### PUT `/api/user/max-upload-size-config`

Update the max upload size (admin only).

**Request Body:**

```json
{
  "maxBytes": 5368709120
}
```

**Validation:**

- `maxBytes`: Required. Integer between 1048576 (1 MB) and 107374182400 (100 GB).

**Response:**

```json
{
  "maxBytes": 5368709120
}
```

## Related Topics

- [Admin Guides](/guides/admin/user-management) - User management
- [Storage Management](/concepts/storage-management) - Storage concepts
