# Sessions API

Session management endpoints for TMA Cloud.

## Get Sessions

### GET `/api/sessions`

Get all active sessions for authenticated user.

**Response:**

```json
{
  "sessions": [
    {
      "id": "session_123",
      "user_id": "user_123",
      "token_version": 1,
      "user_agent": "Mozilla/5.0...",
      "ip_address": "192.168.1.1",
      "created_at": "2024-01-01T00:00:00Z",
      "last_activity": "2024-01-01T12:00:00Z",
      "isCurrent": true
    }
  ]
}
```

## Revoke Session

### DELETE `/api/sessions/:sessionId`

Revoke a specific session.

**Response:**

```json
{
  "message": "Session revoked successfully"
}
```

## Revoke Other Sessions

### POST `/api/sessions/revoke-others`

Revoke all other active sessions except the current one.

**Response:**

```json
{
  "message": "Other sessions revoked successfully",
  "deletedCount": 3
}
```

## Related Topics

- [Authentication](authentication.md) - Authentication endpoints
- [Authentication Concepts](/concepts/authentication) - Authentication overview
