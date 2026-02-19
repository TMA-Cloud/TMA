# Files API

File management endpoints for TMA Cloud.

**Note:** All endpoints that accept `ids` arrays process multiple files in bulk operations. This includes move, copy, star, share, delete, restore, and download operations.

## List Files

### GET `/api/files`

List files and folders.

**Query Parameters:**

- `parentId` - Parent folder ID (optional)
- `sortBy` - Sort field: `name`, `date`, `size`, `type` (optional)
- `order` - Sort order: `asc`, `desc` (optional)

**Response:**

An array of file and folder objects.

```json
[
  {
    "id": "file_123",
    "name": "document.pdf",
    "type": "file",
    "size": 1024,
    "mimeType": "application/pdf",
    "parentId": "folder_456",
    "starred": false,
    "modified": "2024-01-01T00:00:00Z"
  }
]
```

## File Statistics

### GET `/api/files/stats`

Get file statistics (total files, total size).

**Response:**

```json
{
  "totalFiles": 100,
  "totalFolders": 50,
  "sharedCount": 10,
  "starredCount": 25
}
```

## Search Files

### GET `/api/files/search`

Search files.

**Query Parameters:**

- `q` or `query` - Search query (required)
- `limit` - Result limit (optional)

**Response:**

An array of file and folder objects matching the search query.

```json
[
  {
    "id": "file_123",
    "name": "document.pdf",
    "type": "file",
    "size": 1024,
    "mimeType": "application/pdf",
    "parentId": "folder_456",
    "starred": false,
    "modified": "2024-01-01T00:00:00Z"
  }
]
```

## Create Folder

### POST `/api/files/folder`

Create a new folder.

**Request Body:**

```json
{
  "name": "New Folder",
  "parent_id": "parent_folder_id"
}
```

**Validation:**

- `name`: Required. Must not be empty and must contain only valid file name characters (`a-zA-Z0-9_.-`). Max length 100.
- `parentId`: Optional. Must be a string.

**Response:**

The created folder object.

```json
{
  "id": "folder_123",
  "name": "New Folder",
  "type": "folder",
  "size": null,
  "modified": "2024-01-01T00:00:00Z"
}
```

## Check Upload Storage

### POST `/api/files/upload/check`

Check if the user has enough storage space for an upload before sending the file.

**Request Body:**

```json
{
  "fileSize": 1024
}
```

**Validation:**

- `fileSize`: Required. Must be a non-negative integer representing the file size in bytes.

**Response (Success):**

```json
{
  "message": "Storage space available"
}
```

**Response (Error):**

```json
{
  "message": "Storage limit exceeded. Required: 1 GB, available: 500 MB."
}
```

## Upload File

### POST `/api/files/upload`

Upload a file.

**Form Data:**

- `file` - File to upload (required)
- `parent_id` - Parent folder ID (optional)
- `path` - Target path (optional)

**MIME Type Validation:**

- The actual MIME type is detected from the file's content (magic bytes).
- The stored MIME type will always match the actual file content, even if the file extension is different.

**Response:**

The uploaded file object.

```json
{
  "id": "file_123",
  "name": "uploaded_file.pdf",
  "type": "file",
  "size": 1024,
  "mimeType": "application/pdf",
  "parentId": null,
  "modified": "2024-01-01T00:00:00Z"
}
```

## Bulk Upload Files

### POST `/api/files/upload/bulk`

Upload multiple files at once using `multipart/form-data`.

**Form Data:**

- `files` - Files to upload (required)
- `parent_id` - Parent folder ID (optional)
- `path` - Target path (optional)

**Response:**

An array of the uploaded file objects.

```json
[
  {
    "id": "file_123",
    "name": "file1.pdf",
    "type": "file",
    "size": 1024,
    "mimeType": "application/pdf",
    "parentId": null,
    "modified": "2024-01-01T00:00:00Z"
  },
  {
    "id": "file_456",
    "name": "file2.jpg",
    "type": "file",
    "size": 2048,
    "mimeType": "image/jpeg",
    "parentId": null,
    "modified": "2024-01-01T00:00:00Z"
  }
]
```

## Move Files

### POST `/api/files/move`

Move files and/or folders to a different location.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "parentId": "target_folder_id"
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.
- `parentId`: Optional. Must be a string.

**Response:**

```json
{
  "message": "Files moved successfully."
}
```

## Copy Files

### POST `/api/files/copy`

Copy files and/or folders to a different location.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "parentId": "target_folder_id"
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.
- `parentId`: Optional. Must be a string.

**Response:**

```json
{
  "message": "Files copied successfully."
}
```

## Rename File

### POST `/api/files/rename`

Rename a file or folder.

**Request Body:**

```json
{
  "id": "file_123",
  "name": "New Name"
}
```

**Validation:**

- `id`: Required. Must be a string.
- `name`: Required. Must not be empty and must contain only valid file name characters (`a-zA-Z0-9_.-`). Max length 100.

**Response:**

The updated file or folder object.

```json
{
  "id": "file_123",
  "name": "New Name",
  "type": "file",
  "modified": "2024-01-01T00:00:00Z"
}
```

## Star Files

### POST `/api/files/star`

Star or unstar one or more files/folders.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "starred": true
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.
- `starred`: Required. Must be a boolean.

**Response:**

```json
{
  "message": "File starred status updated."
}
```

## Get Starred Files

### GET `/api/files/starred`

List all starred files and folders.

**Query Parameters:**

- `sortBy` - Sort field (optional)
- `order` - Sort order (optional)

**Response:**

An array of file and folder objects.

```json
[
  {
    "id": "file_123",
    "name": "document.pdf",
    "type": "file",
    "size": 1024,
    "mimeType": "application/pdf",
    "parentId": "folder_456",
    "starred": true,
    "modified": "2024-01-01T00:00:00Z"
  }
]
```

## Share Files

### POST `/api/files/share`

Share or unshare files. Creates share links if they don't exist, or removes sharing if `shared: false`.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "shared": true,
  "expiry": "7d"
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.
- `shared`: Required. Must be a boolean.
- `expiry`: Optional. One of `"7d"`, `"30d"`, or `"never"`.

**Response (when sharing):**

```json
{
  "links": {
    "file_123": "http://example.com/s/token123",
    "file_456": "http://example.com/s/token456"
  }
}
```

**Response (when unsharing):**

```json
{
  "message": "Files unshared successfully."
}
```

## Get Share Links

### POST `/api/files/share/links`

Get existing share links for multiple files without creating new ones.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.

**Response:**

```json
{
  "links": {
    "file_123": "http://example.com/s/token123"
  }
}
```

## Link to Parent Share

### POST `/api/files/link-parent-share`

Link files to their parent folder's share link. If the parent folder is shared, the files will be added to that share.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.

**Response:**

```json
{
  "links": {
    "file_123": "http://example.com/s/parent_token"
  }
}
```

## Get Shared Files

### GET `/api/files/shared`

List files and folders shared by the current user. Includes share link expiry information.

**Query Parameters:**

- `sortBy` - Sort field (optional)
- `order` - Sort order (optional)

**Response:**

An array of shared file and folder objects. Each object includes `expiresAt` from the associated share link (`null` if the link has no expiration).

```json
[
  {
    "id": "file_123",
    "name": "document.pdf",
    "type": "file",
    "size": 1024,
    "mimeType": "application/pdf",
    "starred": false,
    "shared": true,
    "modified": "2024-01-01T00:00:00Z",
    "expiresAt": "2024-01-08T00:00:00Z"
  }
]
```

## Delete Files

### POST `/api/files/delete`

Move one or more files/folders to the trash.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.

**Response:**

```json
{
  "message": "Files moved to trash."
}
```

## Get Trash

### GET `/api/files/trash`

List all files and folders currently in the trash.

**Query Parameters:**

- `sortBy` - Sort field (optional)
- `order` - Sort order (optional)

**Response:**

An array of trashed file and folder objects.

```json
[
  {
    "id": "file_123",
    "name": "document.pdf",
    "type": "file",
    "size": 1024,
    "mimeType": "application/pdf",
    "parentId": "folder_456",
    "starred": false,
    "modified": "2024-01-01T00:00:00Z"
  }
]
```

## Restore Files

### POST `/api/files/trash/restore`

Restore one or more files/folders from the trash.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.

**Response:**

```json
{
  "message": "Restored 2 file(s) from trash"
}
```

## Permanent Delete

### POST `/api/files/trash/delete`

Permanently delete one or more files/folders from the trash. This action is irreversible.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.

**Response:**

```json
{
  "message": "Files permanently deleted."
}
```

## Empty Trash

### POST `/api/files/trash/empty`

Permanently delete all files and folders in the trash.

**Response:**

```json
{
  "message": "Deleted 5 file(s) from trash"
}
```

**Note:** If trash is already empty, returns: `{"message": "Trash is already empty"}`

## Download File

### GET `/api/files/:id/download`

Download a single file or a folder (folders are returned as a ZIP archive).

**Validation:**

- `id`: Required. Must be a string.

**Response:**
The raw file content or a ZIP archive.

## Bulk Download Files

### POST `/api/files/download/bulk`

Download multiple files and/or folders as a single ZIP archive.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456", "folder_789"]
}
```

**Validation:**

- `ids`: Required. Must be a non-empty array of strings.

**Response:**
A ZIP archive containing all selected files and folders.

**Note:** For single file downloads, use the GET endpoint. This endpoint is optimized for downloading multiple items at once.

## File Events

### GET `/api/files/events`

Establish a real-time event stream (Server-Sent Events) for file system changes. Requires Redis to be configured.

**Response:**
A Server-Sent Events stream.

## Related Topics

- [Sharing](sharing.md) - Share link endpoints
- [File System Concepts](/concepts/file-system) - File system overview
