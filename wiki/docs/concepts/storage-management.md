# Storage Management

Storage limits and management in TMA Cloud.

## Storage Limits

### Per-User Limits

- Configurable storage limits per user
- Default: 100GB (107374182400 bytes)
- Set by administrators
- Real-time usage tracking

### Storage Calculation

- **Files:** Sum of all file sizes
- **Folders:** Counted as 0 bytes
- **Trash:** Counted until permanently deleted
- **Custom Drives:** Separate limits per drive

## Storage Usage

### Tracking

- Real-time usage calculation
- Visual charts and indicators
- Per-user usage statistics
- System-wide usage overview

### Monitoring

- Usage warnings at thresholds
- Limit enforcement on upload
- Storage quota exceeded errors

## Custom Drives

### Overview

Custom drives allow users to store files on external or mounted storage.

### Configuration

- **Admin-Only:** Configured by administrators
- **Per-User:** Each user can have custom drive
- **Path Mapping:** Host path to container path (Docker)
- **Separate Limits:** Custom storage limits per drive

### Use Cases

- External storage devices
- Network-attached storage (NAS)
- Mounted volumes
- Separate storage pools

## Disk Space Monitoring

### System-Level

- Total disk space available
- Used space calculation
- Free space tracking
- Base path configuration

### User-Level

- Per-user storage usage
- Limit enforcement
- Usage visualization

## Storage Operations

### Upload Limits

- Enforced at upload time
- Prevents exceeding limits
- Clear error messages

### Cleanup

- Trash cleanup frees space
- Orphan file cleanup
- Automatic background processes

## Related Topics

- [File System](file-system.md) - How files are stored
- [Admin Guide: Storage Limits](/guides/admin/storage-limits) - Configure limits
- [Admin Guide: Custom Drives](/guides/admin/custom-drives) - Setup custom drives
