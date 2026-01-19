# Docker Issues

Troubleshooting Docker deployment problems.

## Container Issues

### Container Not Starting

**Check:**

1. Docker logs: `docker compose logs app`
2. Environment variables
3. Volume mounts
4. Port conflicts

**Solutions:**

1. Check logs for specific errors
2. Verify `.env` file exists and is correct
3. Check upload directory permissions: `chown -R 1001:1001 uploads/`
4. Verify ports are available

### Health Check Failing

**Check:**

```bash
docker inspect --format='{{.State.Health.Status}}' tma-cloud-app
```

**Solutions:**

1. Check application logs
2. Verify database connection
3. Check Redis connection (if enabled)
4. Review health check configuration

## Agent Issues

### Agent Connection Failed

**Check:**

1. Agent is running on host
2. Agent URL and token configured in Settings
3. Network connectivity from container to host

**Solutions:**

1. Verify agent is running: `tma-agent start`
2. Check agent health: `curl http://host.docker.internal:8080/health`
3. Verify `docker-compose.yml` has `extra_hosts` for Linux
4. Check agent token matches in Settings

## Network Issues

### Cannot Access Application

**Check:**

1. Container is running: `docker compose ps`
2. Port mapping is correct
3. Firewall rules
4. Container logs

**Solutions:**

1. Verify port mapping: `docker compose ps`
2. Check `BPORT` in `.env`
3. Access via `http://localhost:3000` (or configured port)

## Related Topics

- [Docker Setup](/getting-started/docker) - Docker guide with prebuilt images from `ghcr.io/tma-cloud/tma`
- [Agent Setup](/getting-started/agent-setup) - Install tma-agent from [GitHub Releases](https://github.com/TMA-Cloud/TMA/releases)
- [Environment Setup](/getting-started/environment-setup) - Configuration
