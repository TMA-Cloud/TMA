# Monitoring

System monitoring and health checks in TMA Cloud.

## Health Checks

### Application Health

- Health check endpoint available
- Database connection status
- Redis connection status (if enabled)

### Metrics Endpoint

**Endpoint:** `/metrics`

**Access:** Restricted to IPs in `METRICS_ALLOWED_IPS`

**Metrics:**

- Request counts
- Response times
- Error rates
- System resources

## Monitoring Tools

### Application Logs

- Structured JSON logs
- Request tracking
- Error logging
- Performance metrics

### Database Monitoring

- Connection pool status
- Query performance
- Migration status

### Redis Monitoring

- Cache hit/miss rates
- Connection status
- Memory usage

## Key Metrics

### Performance

- Request latency
- Throughput
- Error rates
- Cache performance

### Resources

- Disk space usage
- Database size
- Memory usage
- CPU usage

### Business

- User counts
- Storage usage
- File operations
- Share link usage

## Best Practices

- Monitor health endpoints
- Set up alerts
- Review logs regularly
- Track key metrics
- Monitor resource usage

## Related Topics

- [Logging](logging.md) - Application logging
- [Audit Logs](audit-logs.md) - Audit system
- [API: Monitoring](/api/monitoring) - Metrics endpoint
