# Logging System

Logging documentation for TMA Cloud.

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
{"level":30,"time":1679251200000,"requestId":"abc123","userId":"user_001","msg":"User logged in"}
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

| Data Type      | Masking                                          |
|----------------|--------------------------------------------------|
| Passwords      | Fully redacted: `[REDACTED]`                     |
| JWT Tokens     | Partial: `eyJhbGci...***...XVCmVw`               |
| Cookies        | Value masked: `sessionId=abc1***def4; HttpOnly`  |
| Authorization  | Bearer token masked: `Bearer eyJh...***...mVw`   |

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
const { logger } = require('./config/logger');

logger.info('User logged in');
logger.info({ userId: 'user_001' }, 'User logged in');
logger.warn({ fileSize: 1024000000 }, 'Large file uploaded');
logger.error({ err }, 'Operation failed');
```

## Log Output

Logs written to stdout. JSON format can be sent to:

- ELK Stack, Datadog, Splunk, CloudWatch, Papertrail

**Example:**

```bash
npm start > logs/app.log 2>&1
```

## Metrics Endpoint

See [API Documentation - Monitoring](api.md#monitoring) for `/metrics` endpoint details.
