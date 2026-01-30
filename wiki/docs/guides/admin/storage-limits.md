# Storage Limits

Configure storage limits for users in TMA Cloud (admin only).

## Storage Limit Overview

### Default Behavior

- Default: Uses actual available disk space
- No hardcoded limits
- Configurable per user
- Set via Settings → Users

### Per-User Limits

- Set custom limits for specific users
- Limits cannot exceed actual disk space
- Monitor usage in real-time
- Limits validated against physical disk capacity

## Setting Storage Limits

### For Individual Users

1. Navigate to **Settings** → **Users**
2. Select user
3. Set storage limit (MB, GB, or TB)
4. Save changes

### Limit Validation

- Limits validated against actual disk space
- Cannot set limit greater than available disk
- Frontend and backend validation

## Storage Usage Monitoring

### User-Level

- View current usage per user (used, total, free)
- Visual indicators
- Usage can be calculated as percentage (used/total)

### System-Level

- Total storage used
- Per-user breakdown
- Storage trends

## Limit Enforcement

### Upload Restrictions

- Uploads blocked when limit reached
- Clear error messages
- Real-time enforcement

### Storage Calculation

- Files count toward limit
- Trash counts until permanently deleted
- Usage tracked in database
- Cache invalidated on file operations

## Best Practices

- Set appropriate limits based on use case
- Monitor usage regularly
- Adjust limits as needed

## Related Topics

- [User Management](user-management.md) - Manage users
- [Storage Management](/concepts/storage-management) - Storage concepts
