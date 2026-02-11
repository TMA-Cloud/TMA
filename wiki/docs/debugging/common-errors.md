# Common Errors

Frequently encountered errors and solutions.

## Database Connection Errors

### Error: "Database connection failed"

**Causes:**

- PostgreSQL not running
- Incorrect credentials
- Network issues

**Solutions:**

1. Verify PostgreSQL is running: `pg_isready`
2. Check `.env` file for correct credentials
3. Test connection: `psql -h localhost -U postgres -d cloud_storage`
4. Verify firewall rules

## Redis Connection Errors

### Error: "Redis connection failed"

**Causes:**

- Redis not running
- Incorrect host/port
- Authentication failed

**Solutions:**

1. Verify Redis is running: `redis-cli ping`
2. Check `REDIS_HOST` and `REDIS_PORT` in `.env`
3. Verify `REDIS_PASSWORD` if set
4. Note: App works without Redis (caching disabled)

## Storage Limit Errors

### Error: "Storage limit exceeded"

**Causes:**

- User storage quota reached
- File too large for remaining quota

**Solutions:**

1. Check storage usage in Settings
2. Delete unnecessary files
3. Empty trash (permanently delete)
4. Admin: Increase storage limit

## Upload Errors

### Error: "This file is too large"

**Causes:**

- File exceeds the max upload size setting

**Solutions:**

1. Check current max upload size in **Settings** → **Storage**
2. Admin: Increase the max upload size
3. Split the file into smaller parts

### Error: "Upload failed"

**Causes:**

- Storage limit exceeded
- Network issues
- Disk space full

**Solutions:**

1. Check storage quota
2. Verify disk space: `df -h`
3. Retry upload

## Authentication Errors

### Error: "Invalid credentials"

**Causes:**

- Wrong email or password
- Account locked
- MFA required

**Solutions:**

1. Verify email and password
2. Check if MFA is enabled
3. Reset password if needed
4. Check account status

## Related Topics

- [Auth Issues](auth-issues.md) - Authentication problems
- [Upload Issues](upload-issues.md) - Upload problems
- [API Errors](/api/errors) - Error codes
