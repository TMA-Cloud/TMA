# API Overview

REST API reference for TMA Cloud backend.

## Base URL

All API endpoints are prefixed with `/api` unless otherwise specified.

## Authentication

Most endpoints require JWT token sent as httpOnly cookie. Rate limiting: 5 attempts per 15 minutes for auth endpoints.

## API Sections

- **[Authentication](authentication.md)** - Login, signup, sessions
- **[Sessions](sessions.md)** - Session management
- **[Files](files.md)** - File operations
- **[Sharing](sharing.md)** - Share links
- **[Users](users.md)** - User management
- **[OnlyOffice](onlyoffice.md)** - Document editing
- **[Monitoring](monitoring.md)** - Health and metrics
- **[Errors](errors.md)** - Error handling
- **[Examples](examples.md)** - Code examples

## Rate Limiting

- **Auth Endpoints:** 5 attempts per 15 minutes
- **API Endpoints:** 100 requests per 15 minutes
- **Upload Endpoints:** 50 uploads per hour

## Response Format

### Success Response

```json
{
  "success": true,
  "data": { ... }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

## HTTP Status Codes

- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Server Error

## Related Topics

- [Authentication](/concepts/authentication) - Authentication concepts
- [API Examples](examples.md) - Code examples
- [Error Codes](errors.md) - Error reference
