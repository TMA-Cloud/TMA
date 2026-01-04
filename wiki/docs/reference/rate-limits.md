# Rate Limits

Rate limiting configuration and limits for TMA Cloud API.

## Rate Limit Configuration

Rate limits are enforced per IP address and endpoint type.

## Endpoint Limits

### Authentication Endpoints

- **Limit:** 5 requests per 15 minutes
- **Endpoints:** `/api/login`, `/api/signup`
- **Purpose:** Prevent brute force attacks

### API Endpoints

- **Limit:** 100 requests per 15 minutes
- **Endpoints:** All `/api/*` endpoints (except auth)
- **Purpose:** Prevent API abuse

### Upload Endpoints

- **Limit:** 50 uploads per hour
- **Endpoints:** `/api/files/upload`
- **Purpose:** Prevent storage abuse

## Rate Limit Headers

When rate limited, responses include:

- `X-RateLimit-Limit` - Maximum requests allowed
- `X-RateLimit-Remaining` - Remaining requests
- `X-RateLimit-Reset` - Time when limit resets

## Rate Limit Errors

When rate limit is exceeded:

**Status Code:** `429 Too Many Requests`

**Response:**

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

## Best Practices

- Implement exponential backoff
- Cache responses when possible
- Batch operations when available
- Monitor rate limit headers

## Related Topics

- [API Overview](/api/overview) - API reference
- [Error Codes](error-codes.md) - Error reference
