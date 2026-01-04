# Redis Issues

Troubleshooting Redis connection problems.

## Connection Errors

### Cannot Connect to Redis

**Check:**

1. Redis is running: `redis-cli ping`
2. Correct host and port in `.env`
3. Network connectivity
4. Firewall rules

**Solutions:**

1. Start Redis: `redis-server` or `docker compose up redis`
2. Verify `REDIS_HOST` and `REDIS_PORT`
3. Test connection: `redis-cli -h localhost -p 6379 ping`
4. Check authentication if password set

## Redis Not Required

**Note:** TMA Cloud works without Redis!

- Caching will be disabled
- Real-time events won't work
- Performance may be slower
- App will function normally

## Docker Redis

### Container Not Starting

**Check:**

1. Docker compose logs: `docker compose logs redis`
2. Port conflicts
3. Volume mounts

**Solutions:**

1. Check logs for errors
2. Verify port 6379 is available
3. Restart container: `docker compose restart redis`

## Related Topics

- [Environment Setup](/getting-started/environment-setup) - Redis configuration
- [Architecture](/concepts/architecture) - System architecture
