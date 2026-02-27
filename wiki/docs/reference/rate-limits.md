# Rate Limits

Rate limiting configuration and limits for TMA Cloud API.

## Rate Limit Configuration

Rate limits are enforced per IP address and/or user for different endpoint types to prevent abuse and ensure service stability.

## Endpoint Limits

### Authentication Limiter

- **Limit:** 25 requests per 15 minutes per IP/email combination.
- **Purpose:** Limits login/signup attempts per IP and email.
- **Endpoints:**
  - `POST /api/login`
  - `POST /api/signup`
  - `GET /api/google/callback`

### General API Limiter

- **Limit:** 10000 requests per 15 minutes per IP address.
- **Purpose:** Limits general API usage per IP.
- **Endpoints:**
  - Public endpoints (e.g. `GET /api/signup-status`).
  - Authenticated auth and profile endpoints (e.g. `/api/profile`, `/api/sessions`, `/api/mfa/*`, `/api/logout`).
  - All file operation endpoints under `/api/files/`.
  - All user management endpoints under `/api/user/` (including `GET /api/user/signup-status`).
  - All version check endpoints under `/api/version/`.
  - OnlyOffice configuration, viewer, and file-serving endpoints under `/api/onlyoffice/`.

### Public Share Link Limiter

- **Limit:** 100 requests per 15 minutes per IP address.
- **Purpose:** Protects public share links from scraping and denial-of-service attacks.
- **Endpoints:** All endpoints under `/s/`.

### Upload Limiter

- **Limit:** 20000 uploads per 30 minutes per user (or per IP if unauthenticated).
- **Purpose:** Limits upload volume per user.
- **Endpoints:**
  - `POST /api/files/upload`
  - `POST /api/files/upload/bulk`
  - `POST /api/files/:id/replace`

### Specialized MFA Limiters

- **MFA Verification/Disabling:** 5 attempts per minute per IP/user.
  - `POST /api/mfa/verify`
  - `POST /api/mfa/disable`
- **Backup Code Regeneration:** 3 attempts per 10 minutes per user.
  - `POST /api/mfa/backup-codes/regenerate`

### SSE Connection Limiter

- **Limit:** 20 concurrent Server-Sent Events connections per user.
- **Purpose:** Limits real-time event streams per user.
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
- [Error Codes](error-codes.md) - Error reference
