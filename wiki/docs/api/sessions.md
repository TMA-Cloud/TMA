# Sessions API

Session management endpoints for TMA Cloud.

## Get Sessions

### GET `/api/sessions`

Get all active sessions for authenticated user.

**Response:**

```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "id": "session_123",
        "userAgent": "Mozilla/5.0...",
        "ipAddress": "192.168.1.1",
        "createdAt": "2024-01-01T00:00:00Z",
        "lastActivity": "2024-01-01T12:00:00Z",
        "current": true
      }
    ]
  }
}
```

## Revoke Session

### DELETE `/api/sessions/:sessionId`

Revoke a specific session.

**Response:**

```json
{
  "success": true,
  "message": "Session revoked"
}
```

## Revoke Other Sessions

### POST `/api/sessions/revoke-others`

Revoke all other active sessions except the current one.

**Response:**

```json
{
  "success": true,
  "message": "All other sessions revoked"
}
```

## Related Topics

- [Authentication](authentication.md) - Authentication endpoints
- [Authentication Concepts](/concepts/authentication) - Authentication overview
