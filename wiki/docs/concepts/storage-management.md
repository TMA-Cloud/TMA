# Storage Management

Storage limits and management in TMA Cloud.

## Storage Limits

### Per-User Limits

- Configurable storage limits per user
- Default: Uses actual available disk space
- Set by administrators
- Real-time usage tracking
- Limits validated against physical disk capacity

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

## File Encryption

Files are automatically encrypted when custom drive is disabled. Encryption uses AES-256-GCM with authenticated encryption.

### Behavior

- **Enabled:** Files in `UPLOAD_DIR` are encrypted
- **Disabled:** Files on custom drives are not encrypted
- **Transparent:** Encryption and decryption happen automatically
- **Streaming:** Large files processed in streams to avoid memory issues

### Key Configuration

- Set `FILE_ENCRYPTION_KEY` environment variable
- Generate key: `openssl rand -base64 32`
- Key can be base64, hex, or string (derived with PBKDF2)
- Development fallback key used if not set (not secure for production)

## Custom Drives

Custom drives allow users to store files on external or mounted storage. Files on custom drives are not encrypted.

### Drive Configuration

- **Admin-Only:** Configured by administrators
- **Per-User:** Each user can have custom drive
- **Path Mapping:** Host path to container path (Docker)
- **Separate Limits:** Custom storage limits per drive

### Real-Time Synchronization

- File system watcher monitors custom drive directories
- Changes detected automatically (additions, modifications, deletions)
- Database updated in real-time
- Frontend receives updates via Server-Sent Events
- UI updates without manual refresh

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

- Pre-upload validation (Content-Length check)
- Final safeguard check (actual file size)
- Prevents file upload if limit exceeded
- Clear error messages with usage details
- Files cleaned up if validation fails

### Cleanup

- Trash cleanup frees space
- Orphan file cleanup
- Automatic background processes

## Related Topics

- [File System](file-system.md) - How files are stored
- [Admin Guide: Storage Limits](/guides/admin/storage-limits) - Configure limits
- [Admin Guide: Custom Drives](/guides/admin/custom-drives) - Setup custom drives
