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

Get currently deployed backend version.

**Response:**

```json
{
  "backend": "2.0.4"
}
```

### GET `/api/version/latest`

Fetch latest versions from update feed. Admin only (first user).

**Response:**

The response format depends on the external update feed. Example:

```json
{
  "current": "2.0.4",
  "latest": "2.0.5",
  "updateAvailable": true
}
```

**Note:** This endpoint proxies the response directly from the update feed. If the request fails, returns an error response.

## Related Topics

- [Monitoring](/guides/operations/monitoring) - Monitoring guide
- [Operations](/guides/operations/background-workers) - Background services
