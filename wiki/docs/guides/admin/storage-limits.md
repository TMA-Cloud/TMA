# Storage Limits

Configure storage limits for users in TMA Cloud (admin only).

## Storage Limit Overview

### Default Limits

- Default: 100GB (107374182400 bytes)
- Configurable per user
- Set via Settings → Users

### Per-User Limits

- Override default for specific users
- Set custom limits as needed
- Monitor usage in real-time

## Setting Storage Limits

### For Individual Users

1. Navigate to **Settings** → **Users**
2. Select user
3. Set storage limit
4. Save changes

### Default Limit

- Set in environment variable: `STORAGE_LIMIT`
- Applies to new users
- Can be overridden per-user

## Storage Usage Monitoring

### User-Level

- View current usage per user
- See percentage of limit used
- Visual indicators

### System-Level

- Total storage used
- Per-user breakdown
- Storage trends

## Custom Drive Limits

### Separate Limits

- Custom drives can have separate limits
- Configured per user
- Independent from main storage

## Limit Enforcement

### Upload Restrictions

- Uploads blocked when limit reached
- Clear error messages
- Real-time enforcement

### Storage Calculation

- Files count toward limit
- Trash counts until permanently deleted
- Custom drives counted separately

## Best Practices

- Set appropriate limits based on use case
- Monitor usage regularly
- Adjust limits as needed
- Consider custom drives for power users

## Related Topics

- [User Management](user-management.md) - Manage users
- [Custom Drives](custom-drives.md) - Configure custom storage
- [Storage Management](/concepts/storage-management) - Storage concepts
