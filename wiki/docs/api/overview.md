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

The API employs rate limiting to prevent abuse and ensure service stability. Different limits are applied to authentication, file uploads, and general API endpoints. For detailed information, see the [Rate Limits](/reference/rate-limits) reference.

## Response Format

Success responses return the requested data directly as a JSON object or array.

### Error Response

```json
{
  "message": "Error message"
}
```

For validation errors, the response includes a `details` field:

```json
{
  "message": "Validation failed",
  "details": [{ "field_name": "Specific error message" }]
}
```

## HTTP Status Codes

- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `422` - Unprocessable Entity (Validation Error)
- `500` - Server Error
- `503` - Service Unavailable

## Related Topics

- [Authentication](/concepts/authentication) - Authentication concepts
- [API Examples](examples.md) - Code examples
- [Error Codes](errors.md) - Error reference
