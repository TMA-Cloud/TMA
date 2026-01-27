# Logging

Logging system documentation for TMA Cloud.

## Overview

TMA Cloud uses [Pino](https://getpino.io/) for structured logging with automatic secret masking.

## Configuration

### Environment Variables

```bash
LOG_LEVEL=info        # fatal, error, warn, info, debug, trace
LOG_FORMAT=json       # json or pretty
METRICS_ALLOWED_IPS=127.0.0.1,::1
```

**Recommendation:**

- Production: `LOG_LEVEL=info`, `LOG_FORMAT=json`
- Development: `LOG_LEVEL=debug`, `LOG_FORMAT=pretty`

## Log Formats

### JSON Format (Production)

Structured JSON logs for log aggregation:

```json
{
  "level": 30,
  "time": 1679251200000,
  "requestId": "abc123",
  "userId": "user_001",
  "msg": "User logged in"
}
```

### Pretty Format (Development)

Human-readable colored output:

```bash
[14:20:00.123] INFO  (12345): User logged in
    requestId: "abc123"
    userId: "user_001"
```

## Secret Masking

Automatic redaction of sensitive data:

| Data Type     | Masking                                         |
| ------------- | ----------------------------------------------- |
| Passwords     | Fully redacted: `[REDACTED]`                    |
| JWT Tokens    | Partial: `eyJhbGci...***...XVCmVw`              |
| Cookies       | Value masked: `sessionId=abc1***def4; HttpOnly` |
| Authorization | Bearer token masked: `Bearer eyJh...***...mVw`  |

## Request Logging

All HTTP requests automatically logged with:

- Request ID, method, URL, headers (masked), query params
- User ID (if authenticated)
- Response status, response time, headers (masked)

## Context Propagation

- **Request ID:** Unique identifier for each request
- **User ID:** Included in authenticated requests

## Logging in Code

```javascript
const { logger } = require("./config/logger");

logger.info("User logged in");
logger.info({ userId: "user_001" }, "User logged in");
logger.warn({ fileSize: 1024000000 }, "Large file uploaded");
logger.error({ err }, "Operation failed");
```

## Log Output

Logs written to stdout. JSON format can be sent to:

- ELK Stack, Datadog, Splunk, CloudWatch, Papertrail

**Example:**

```bash
npm start > logs/app.log 2>&1
```

## Agent Logs (`tma-agent`)

The `tma-agent` process writes its own log file next to the agent binary and `tma-agent.json`.

### Location

- Linux/macOS (default install): `/usr/local/bin/tma-agent.log`
- Windows (default install): `C:\Program Files\TMA Drive Agent\tma-agent.log`
- Manual runs: same directory as the downloaded agent binary

### What is logged

- Agent startup (port, configured paths, token presence, webhook configuration)
- Token generation events (including the generated token)
- Config reloads and config watcher errors
- File watcher events (start/stop watching paths, watcher errors, webhook failures)
- File writes and deletes performed via the agent API
- Unauthorized API requests (remote address, method, path)

Timestamps are written in UTC for consistent correlation with backend logs and metrics.

### Rotation

The agent rotates its log file when it reaches about 5 MB:

- The current file is renamed to `tma-agent-YYYYMMDD-HHMMSS.log`
- A new `tma-agent.log` file is opened
- Up to 3 rotated files are kept; older ones are removed on a best-effort basis

Rotation runs on agent startup and periodically while the agent is running. If the agent cannot write or delete files in its install directory, rotation keeps writing to the existing `tma-agent.log` and a warning is printed to stderr.

## Metrics Endpoint

See [API: Monitoring](/api/monitoring) for `/metrics` endpoint details.

## Related Topics

- [Audit Logs](audit-logs.md) - Audit trail system
- [Monitoring](monitoring.md) - System monitoring
- [Debugging: Common Errors](/debugging/common-errors) - Troubleshooting
