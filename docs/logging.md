# Logging System

Comprehensive logging documentation for TMA Cloud.

## Overview

TMA Cloud uses [Pino](https://getpino.io/), a high-performance structured logging library for Node.js, to provide comprehensive application logging with automatic secret masking and multiple output formats.

### Key Features

- **Structured Logging**: JSON-formatted logs for easy parsing and analysis
- **High Performance**: Asynchronous logging with minimal overhead
- **Secret Masking**: Automatic redaction of sensitive data (JWTs, passwords, cookies, tokens)
- **Multiple Formats**: JSON for production, pretty-print for development
- **Request Logging**: Automatic HTTP request/response logging
- **Context Propagation**: Request ID and user ID tracked across all logs

## Configuration

### Environment Variables

Configure logging via environment variables in the `.env` file:

```bash
# Log level (fatal, error, warn, info, debug, trace)
LOG_LEVEL=debug

# Log format (json, pretty)
LOG_FORMAT=pretty

# Allowed IPs for metrics endpoint
METRICS_ALLOWED_IPS=127.0.0.1,::1
```

See [Environment Variables](environment.md) for detailed configuration options.

### Log Levels

Pino supports the following log levels (in order of severity):

| Level | Value | Description | Use Case |
|-------|-------|-------------|----------|
| `fatal` | 60 | Application crash | Critical errors that require immediate attention |
| `error` | 50 | Error conditions | Errors that don't crash the app but need investigation |
| `warn` | 40 | Warning conditions | Potential issues or deprecated usage |
| `info` | 30 | Informational | General application flow (default for production) |
| `debug` | 20 | Debug information | Detailed debugging info (recommended for development) |
| `trace` | 10 | Very detailed | Extremely detailed tracing (rarely needed) |

**Recommendation:**

- **Production**: `LOG_LEVEL=info`
- **Development**: `LOG_LEVEL=debug`

## Log Formats

### JSON Format (Production)

Structured JSON logs, ideal for log aggregation systems:

```json
{"level":30,"time":1679251200000,"pid":12345,"hostname":"server","requestId":"abc123","userId":"user_001","msg":"User logged in","email":"user@example.com"}
```

**Best for:**

- Production environments
- Log aggregation tools (ELK, Datadog, Splunk)
- Automated parsing and analysis

### Pretty Format (Development)

Human-readable colored output:

```bash
[14:20:00.123] INFO  (12345): User logged in
    requestId: "abc123"
    userId: "user_001"
    email: "user@example.com"
```

**Best for:**

- Local development
- Debugging
- Manual log review

## Secret Masking

### Automatic Redaction

All sensitive data is automatically masked in logs at any log level:

| Data Type | Masking Strategy | Example |
|-----------|------------------|---------|
| **Passwords** | Fully redacted | `[REDACTED]` |
| **JWT Tokens** | Partial masking | `eyJhbGci...***...XVCmVw` |
| **Cookies** | Value masking, preserve options | `sessionId=abc1***def4; HttpOnly; Secure` |
| **Authorization Headers** | Bearer token masking | `Bearer eyJh...***...mVw` |
| **API Keys** | Partial masking | `sk_t***key` |
| **OAuth Secrets** | Fully redacted | `[REDACTED]` |

## Request Logging

### HTTP Request/Response Logging

All HTTP requests are automatically logged with:

**Request Info:**

- Request ID (unique identifier)
- HTTP method
- URL path
- Headers (with secrets masked)
- Query parameters
- User ID (if authenticated)

**Response Info:**

- Status code
- Response time
- Headers (with Set-Cookie masked)

### Example Request Log

```json
{
  "level": 30,
  "time": 1679251200000,
  "requestId": "abc123",
  "userId": "user_001",
  "req": {
    "id": "abc123",
    "method": "POST",
    "url": "/api/files/upload",
    "headers": {
      "authorization": "Bearer eyJh...***...mVw",
      "cookie": "token=abc1***def4; HttpOnly"
    }
  },
  "res": {
    "statusCode": 200,
    "headers": {
      "set-cookie": ["token=xyz9***abc1; HttpOnly; Secure"]
    }
  },
  "responseTime": 45,
  "msg": "request completed"
}
```

## Context Propagation

### Request ID

Every HTTP request gets a unique request ID:

```javascript
// Automatically generated and logged with every message
requestId: "req_abc123def456"
```

**Usage:**

- Track all logs related to a single request
- Debug issues across multiple log entries
- Correlate frontend and backend logs

### User ID

Authenticated requests include user ID:

```javascript
userId: "user_abc123"
```

**Usage:**

- Track user-specific actions
- Audit user behavior
- Debug user-reported issues

## Logging in Code

### Basic Logging

```javascript
const { logger } = require('./config/logger');

// Info level
logger.info('User logged in');

// With metadata
logger.info({ userId: 'user_001', email: 'user@example.com' }, 'User logged in');

// Warning
logger.warn({ fileSize: 1024000000 }, 'Large file uploaded');

// Error
logger.error({ err }, 'Failed to process file');
```

### Error Logging

```javascript
try {
  // Some operation
} catch (err) {
  logger.error({ err }, 'Operation failed');
  // err.stack and err.message are automatically included
}
```

### Child Loggers

Create child loggers with additional context:

```javascript
const childLogger = logger.child({ module: 'fileProcessor' });
childLogger.info('Processing started');
// Logs will include: module: "fileProcessor"
```

## Log Files and Output

### Standard Output

Logs are written to stdout:

```bash
# View logs in terminal
npm start

# View audit worker logs
npm run worker
```

### Log Aggregation

JSON format logs can be sent to:

- **ELK Stack** (Elasticsearch, Logstash, Kibana)
- **Datadog**
- **Splunk**
- **CloudWatch**
- **Papertrail**

Example with file output:

```bash
# Redirect logs to file
npm start > logs/app.log 2>&1

# Rotate logs with logrotate (Linux)
# Create /etc/logrotate.d/tmacloud
```

## Metrics Endpoint

Application metrics are available via the `/metrics` endpoint. For complete documentation including access control, available metrics, and configuration, see [API Documentation - Monitoring](api.md#monitoring).

## Related Documentation

- [Environment Variables](environment.md) - Logging configuration
- [Audit Logging](audit.md) - Audit trail system
- [Architecture](architecture.md) - System architecture
- [API Documentation](api.md) - API endpoints

## External Resources

- [Pino Documentation](https://getpino.io/)
- [Pino Best Practices](https://getpino.io/#/docs/best-practices)
- [Structured Logging](https://www.thoughtworks.com/insights/blog/application-logging-what-when-how)
