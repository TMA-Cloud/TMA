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
- **MIME Type:** Actual MIME type detected from file content (not from extension)
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

### Large File Handling

- **Streaming:** Files streamed without loading into memory
- **Upload:** Temp files streamed directly to destination
- **Download:** Files streamed from storage to client
- **ZIP Archives:** Files streamed into archive without buffering
- **Rename:** Change file/folder names

### Performance

- Streaming prevents memory exhaustion for large files (>1GB)
- Rename operations use OS-level rename when available
- No file size limits imposed by memory constraints

### Path Management

- Paths stored as full strings
- Automatic path updates on move/rename
- Path validation prevents traversal attacks

## Storage

### Physical Storage

- **Local:** Files stored in `UPLOAD_DIR`. Database stores path.
- **S3:** Files stored in S3-compatible object storage. Database stores object key.
- Set `STORAGE_DRIVER=local` (default) or `s3`. Same operations (upload, download, copy, share) work for both.
- Original filenames preserved in database

### File Encryption

- Files encrypted with AES-256-GCM
- Encryption key configured via `FILE_ENCRYPTION_KEY` environment variable
- Files stored in format: `[IV][ENCRYPTED_DATA][TAG]`
- Automatic decryption on download

### Storage Limits

- Per-user storage limits
- Configurable by administrators
- Real-time usage tracking

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

- [Storage Management](storage-management.md) - Storage limits
- [Sharing Model](sharing-model.md) - How files are shared
- [User Guide: Upload Files](/guides/user/upload-files) - How to use the file system
