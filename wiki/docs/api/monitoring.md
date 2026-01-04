# Monitoring API

Health and metrics endpoints for TMA Cloud.

## Metrics

### GET `/metrics`

Get application health and performance metrics. Restricted to IPs in `METRICS_ALLOWED_IPS`.

**Response:**
Prometheus metrics format

**Example:**

```
http_requests_total{method="GET",status="200"} 1234
http_request_duration_seconds{method="GET"} 0.05
```

## Version

### GET `/api/version`

Get currently deployed backend version.

**Response:**

```json
{
  "success": true,
  "data": {
    "version": "2.0.4"
  }
}
```

### GET `/api/version/latest`

Fetch latest versions from update feed.

**Response:**

```json
{
  "success": true,
  "data": {
    "current": "2.0.4",
    "latest": "2.0.5",
    "updateAvailable": true
  }
}
```

## Related Topics

- [Monitoring](/guides/operations/monitoring) - Monitoring guide
- [Operations](/guides/operations/background-workers) - Background services
