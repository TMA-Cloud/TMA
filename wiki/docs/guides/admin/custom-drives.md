# Custom Drives

Configure custom drive storage for users in TMA Cloud (admin only).

## Custom Drive Overview

### What are Custom Drives?

Custom drives allow users to store files on external or mounted storage instead of the default upload directory.

### Use Cases

- External storage devices
- Network-attached storage (NAS)
- Mounted volumes
- Separate storage pools

## Configuration

### Docker Setup

1. Add `CUSTOM_DRIVE_MOUNT_N` to `.env`:

   ```bash
   CUSTOM_DRIVE_MOUNT_1=/host/path:/container/path
   CUSTOM_DRIVE_MOUNT_2=/mnt/data:/data/storage
   ```

2. Add volume mounts to `docker-compose.yml` if needed

3. Set permissions:

   ```bash
   chown -R 1001:1001 /host/path
   ```

### Per-User Configuration

1. Navigate to **Settings** → **Users**
2. Select user
3. Enable custom drive
4. Set drive path
5. Configure storage limit (optional)

## Drive Path Format

### Docker Format

```
/host/path:/container/path
```

- Host path: Path on Docker host
- Container path: Path inside container
- Must include colon separator

### Path Validation

- Paths validated before saving
- Must be absolute paths
- Must exist and be accessible

## Storage Limits

### Separate Limits

- Custom drives can have separate storage limits
- Independent from main storage
- Configured per user

### Usage Tracking

- Track usage per drive
- Monitor storage consumption
- Enforce limits

## Custom Drive Scanner

### Automatic Scanning

- Background service watches custom drives
- Syncs files to database
- Handles file changes

### Configuration

- Per-user scanner configuration
- Automatic file detection
- Metadata extraction

## Best Practices

- Use for power users with large storage needs
- Monitor drive usage
- Set appropriate limits
- Ensure proper permissions

## Related Topics

- [User Management](user-management.md) - Manage users
- [Storage Limits](storage-limits.md) - Configure limits
- [Storage Management](/concepts/storage-management) - Storage concepts
