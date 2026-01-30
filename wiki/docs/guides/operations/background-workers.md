# Background Workers

Background services and workers in TMA Cloud.

## Overview

TMA Cloud uses background workers for asynchronous processing and maintenance tasks.

## Workers

### Audit Worker

**Purpose:** Process audit events asynchronously

**Command:**

```bash
npm run worker
```

**Configuration:**

- `AUDIT_WORKER_CONCURRENCY` - Concurrent events processed
- `AUDIT_JOB_TTL_SECONDS` - Job TTL

**Important:** Must run in production. Audit events queued but not written until processed.

### Cleanup Services

#### Trash Cleanup

- Automatic deletion after 15 days
- Background scheduler
- Permanent file deletion

#### Orphan Cleanup

- Removes files without database records
- Periodic scanning
- Disk space recovery

## Running Workers

### Production

```bash
# Terminal 1 - Main application
npm start

# Terminal 2 - Audit worker (required)
npm run worker
```

### Docker

Workers run as separate containers:

```bash
docker compose up -d
# Starts app, worker, and redis
```

## Monitoring Workers

### Monitoring Audit Worker

- Check logs for processing status
- Monitor queue size
- Verify events being written

### Monitoring Cleanup Services

- Check logs for cleanup operations
- Monitor disk space
- Verify cleanup schedules

## Best Practices

- Always run audit worker in production
- Monitor worker health
- Check logs regularly
- Verify background tasks completing

## Related Topics

- [Audit Logs](audit-logs.md) - Audit system
- [Monitoring](monitoring.md) - System monitoring
- [Logging](logging.md) - Application logging
