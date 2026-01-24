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

### Custom Drive Setup

See [Agent Setup](/getting-started/agent-setup) for agent installation and configuration. Prebuilt `tma-agent` binaries are available in [GitHub Releases](https://github.com/TMA-Cloud/TMA/releases) for Linux, Windows, and macOS.

### Per-User Configuration

1. Navigate to **Settings** → **Users**
2. Select user
3. Enable custom drive
4. Set drive path
5. Configure ignore patterns (optional)
6. Configure storage limit (optional)

## Drive Path Format

### Path Requirements

- Must be absolute paths
- Must exist and be accessible on the host system
- Must be within agent-configured paths
- Paths validated before saving

## Storage Limits

### Separate Limits

- Custom drives can have separate storage limits
- Independent from main storage
- Configured per user

### Usage Tracking

- Track usage per drive
- Monitor storage consumption
- Enforce limits
- Disk space queried via agent API

### Disk Space Reporting

- Agent API returns filesystem statistics for the mounted volume
- In Docker environments, reports actual custom drive space, not Docker host space

## Custom Drive Scanner

### Automatic Scanning

- Background service watches custom drives
- Syncs files to database on startup
- Handles file changes in real-time

### Real-Time Synchronization

**Local Environment:**

- File system watcher monitors custom drive directories
- Detects file additions, changes, and deletions
- Updates database automatically

**Docker Environment:**

- Agent watches file system on host
- Sends webhook notifications to backend
- Backend processes changes and updates database

- Publishes events to frontend via Server-Sent Events (SSE)
- Frontend updates UI without manual refresh

### Scanner Behavior

- Per-user scanner configuration
- Automatic file detection
- Metadata extraction
- Watches up to 99 directory levels deep
- Debounced processing (500ms) to batch rapid changes
- Cache invalidation ensures fresh data on refresh

### Watcher Configuration

**Local Environment:**

- Watches all subdirectories recursively
- Waits 1 second after file stops changing before processing
- Handles permission errors gracefully
- Supports atomic file writes

**Docker Environment:**

- Agent handles file system watching on host
- Webhook notifications sent to backend
- No direct file system access from container

### Ignore Patterns

Configure which files and folders to ignore during scanning.

#### Pattern Matching

- Patterns match exactly by default
- Use `*` for wildcard matching
- Patterns are case-insensitive
- Multiple patterns can be configured

#### Examples

- `.git` - Matches only `.git` folder/file
- `.git*` - Matches `.git`, `.gitignore`, `.gitconfig`, etc.
- `node_modules` - Matches only `node_modules` folder
- `*.tmp` - Matches any file ending with `.tmp`
- `myfold*` - Matches files/folders starting with `myfold`

#### Pattern Configuration

1. Enable custom drive for user
2. Click **Edit** next to Ignore Patterns
3. Add patterns one per line
4. Click **Save** to apply

#### Default Behavior

- No patterns configured: All files are scanned
- Empty patterns array: All files are scanned

## Best Practices

- Use for power users with large storage needs
- Monitor drive usage
- Set appropriate limits
- Ensure proper permissions

## Related Topics

- [User Management](user-management.md) - Manage users
- [Storage Limits](storage-limits.md) - Configure limits
- [Storage Management](/concepts/storage-management) - Storage concepts
