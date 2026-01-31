# Storage Limits

Configure storage limits for users in TMA Cloud (admin only).

## Storage Limit Overview

### Default Behavior

- **Local:** Default uses actual available disk space.
- **S3:** No disk; default is unlimited when no limit set. UI shows "X used of Unlimited" or "X used of Y" when limit set.
- No hardcoded limits; configurable per user; set via Settings → Users

### Per-User Limits

- Set custom limits for specific users
- **Local:** Limits cannot exceed actual disk space; validated against disk capacity.
- **S3:** Only per-user limit enforced; no disk cap.
- Monitor usage in real-time

## Setting Storage Limits

### For Individual Users

1. Navigate to **Settings** → **Users**
2. Select user
3. Set storage limit (MB, GB, or TB)
4. Save changes

### Limit Validation

- **Local:** Limits validated against actual disk space; cannot set limit greater than available disk.
- **S3:** Only per-user limit; no disk validation.
- Frontend and backend validation

## Storage Usage Monitoring

### User-Level

- View current usage per user (used, total, free)
- **Local:** total/free from disk and per-user limit; percentage when total > 0.
- **S3:** total/free from per-user limit or "Unlimited" when no limit; percentage shown only when limit set.
- Visual indicators

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
