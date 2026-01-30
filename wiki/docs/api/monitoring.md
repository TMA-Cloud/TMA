# Monitoring API

Health and metrics endpoints for TMA Cloud.

## Health Check

### GET `/health`

Get application health status. No authentication required.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 12345.67
}
```

## Metrics

### GET `/metrics`

Get application health and performance metrics. Restricted to IPs in `METRICS_ALLOWED_IPS`.

**Response:**
Prometheus metrics format

**Example:**

```bash
http_requests_total{method="GET",status="200"} 1234
http_request_duration_seconds{method="GET"} 0.05
```

## Version

### GET `/api/version`

Get currently deployed backend and frontend versions.

**Rate limiting:** 100 requests per 15 minutes.

**Response:**

```json
{
  "backend": "2.0.5",
  "frontend": "2.0.5"
}
```

- `backend`: Backend version from package.json
- `frontend`: Frontend version from package.json

### GET `/api/version/latest`

Fetch latest versions from update feed. Admin only (first user).

**Rate limiting:** 100 requests per 15 minutes.

**Response:**

The response format depends on the external update feed. Example:

```json
{
  "frontend": "2.0.5",
  "backend": "2.0.5"
}
```

**Note:** This endpoint proxies the response directly from the update feed. If the request fails, returns an error response.

## Related Topics

- [Monitoring](/guides/operations/monitoring) - Monitoring guide
- [Operations](/guides/operations/background-workers) - Background services
