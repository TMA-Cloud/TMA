# File System

File system architecture and organization in TMA Cloud.

## File Structure

### Hierarchical Organization

- **Root Level:** User's root directory
- **Folders:** Nested folder structure
- **Files:** Stored within folders or root

### File Metadata

- **ID:** Unique identifier (stable across operations)
- **Name:** File or folder name
- **Type:** 'file' or 'folder'
- **Size:** File size in bytes (folders: 0)
- **MIME Type:** File MIME type
- **Parent ID:** Parent folder reference
- **Path:** Full path string
- **User ID:** Owner reference

## File Operations

### Supported Operations

- **Upload:** Add new files
- **Download:** Retrieve files
- **Create Folder:** Create new directories
- **Move:** Move files/folders
- **Copy:** Duplicate files/folders
- **Rename:** Change file/folder names
- **Delete:** Move to trash
- **Star:** Mark as favorite
- **Share:** Create share links

### Path Management

- Paths stored as full strings
- Automatic path updates on move/rename
- Path validation prevents traversal attacks

## Storage

### Physical Storage

- Files stored in `UPLOAD_DIR` directory
- Organized by user ID and file ID
- Original filenames preserved in database

### File Encryption

- Files encrypted with AES-256-GCM when custom drive is disabled
- Encryption key configured via `FILE_ENCRYPTION_KEY` environment variable
- Files stored in format: `[IV][ENCRYPTED_DATA][TAG]`
- Automatic decryption on download
- Custom drive files are not encrypted

### Storage Limits

- Per-user storage limits
- Configurable by administrators
- Real-time usage tracking
- Custom drive support (per-user)

## Trash System

### Soft Delete

- Files moved to trash (not deleted)
- `deleted_at` timestamp set
- Restorable within retention period

### Automatic Cleanup

- Trash items deleted after 15 days
- Background worker handles cleanup
- Permanent deletion after retention

## Search

### Trigram Similarity Search

- PostgreSQL pg_trgm extension for fuzzy text matching
- GIN index on file names for fast searches
- Prefix matching for short queries
- Similarity-based matching for longer queries
- Real-time search results
- User-scoped searches

## Related Topics

- [Storage Management](storage-management.md) - Storage limits and custom drives
- [Sharing Model](sharing-model.md) - How files are shared
- [User Guide: Upload Files](/guides/user/upload-files) - How to use the file system
