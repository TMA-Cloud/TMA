# Rate Limits

Rate limiting configuration and limits for TMA Cloud API.

## Rate Limit Configuration

Rate limits are enforced per IP address and/or user for different endpoint types to prevent abuse and ensure service stability.

## Endpoint Limits

### Strict Authentication Limiter

- **Limit:** 5 requests per 15 minutes per IP/email combination.
- **Purpose:** Prevents brute-force attacks on critical authentication endpoints.
- **Endpoints:**
  - `POST /api/login`
  - `POST /api/signup`
  - `GET /api/google/callback`

### General API Limiter

- **Limit:** 100 requests per 15 minutes per IP address.
- **Purpose:** Prevents abuse of general application functionality.
- **Endpoints:**
  - Most authenticated endpoints under `/api/auth/`, including profile, session management, and some MFA operations.
  - All file operation endpoints under `/api/files/`.
  - All user management endpoints under `/api/user/`.
  - All version check endpoints under `/api/version/`.
  - OnlyOffice configuration, viewer, and file-serving endpoints under `/api/onlyoffice/`.

### Public Share Link Limiter

- **Limit:** 100 requests per 15 minutes per IP address.
- **Purpose:** Protects public share links from scraping and denial-of-service attacks.
- **Endpoints:** All endpoints under `/s/`.

### Upload Limiter

- **Limit:** 50 uploads per hour per user/IP.
- **Purpose:** Prevents storage abuse through rapid file uploads.
- **Endpoints:**
  - `POST /api/files/upload`
  - `POST /api/files/upload/bulk`

### Specialized MFA Limiters

- **MFA Verification/Disabling:** 5 attempts per minute per IP/user.
  - `POST /api/mfa/verify`
  - `POST /api/mfa/disable`
- **Backup Code Regeneration:** 3 attempts per 10 minutes per user.
  - `POST /api/mfa/backup-codes/regenerate`

### SSE Connection Limiter

- **Limit:** 3 concurrent Server-Sent Events connections per user.
- **Purpose:** Prevents resource exhaustion from too many real-time connections.
- **Endpoint:** `GET /api/files/events`

## Rate Limit Headers

Responses for rate-limited requests include the following headers:

- `RateLimit-Limit`: The maximum number of requests allowed in the current window.
- `RateLimit-Remaining`: The number of requests remaining in the current window.
- `RateLimit-Reset`: The time when the limit resets, in UTC seconds.
- `Retry-After`: The number of seconds to wait before making a new request (sent with 429 responses).

## Rate Limit Errors

When a rate limit is exceeded:

**Status Code:** `429 Too Many Requests`

**Response:**

```json
{
  "error": "Too many requests, please try again later"
}
```

Some endpoints provide a more specific message and additional data:

```json
{
  "message": "Too many backup code regeneration attempts, please try again later",
  "retryAfterMs": 225000
}
```

## Best Practices

- Implement exponential backoff for retries.
- Use the `Retry-After` header to time subsequent requests.
- Cache API responses when possible to reduce unnecessary requests.
- Use bulk endpoints where available to consolidate operations.

## Related Topics

- [API Overview](/api/overview) - API reference
- [Error Codes](errors.md) - Error reference
