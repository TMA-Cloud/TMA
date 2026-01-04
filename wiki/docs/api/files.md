# Files API

File management endpoints for TMA Cloud.

## List Files

### GET `/api/files`

List files and folders.

**Query Parameters:**

- `parentId` - Parent folder ID (optional)
- `sortBy` - Sort field: `name`, `date`, `size`, `type` (optional)
- `order` - Sort order: `asc`, `desc` (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "file_123",
        "name": "document.pdf",
        "type": "file",
        "size": 1024,
        "mimeType": "application/pdf",
        "parentId": "folder_456",
        "starred": false,
        "createdAt": "2024-01-01T00:00:00Z"
      }
    ]
  }
}
```

## File Statistics

### GET `/api/files/stats`

Get file statistics (total files, total size).

**Response:**

```json
{
  "success": true,
  "data": {
    "totalFiles": 100,
    "totalSize": 1073741824
  }
}
```

## Search Files

### GET `/api/files/search`

Search files.

**Query Parameters:**

- `q` or `query` - Search query (required)
- `limit` - Result limit (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "files": [ ... ]
  }
}
```

## Create Folder

### POST `/api/files/folder`

Create folder.

**Request Body:**

```json
{
  "name": "New Folder",
  "parent_id": "parent_folder_id"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "folder_123",
    "name": "New Folder",
    "type": "folder"
  }
}
```

## Upload File

### POST `/api/files/upload`

Upload file.

**Form Data:**

- `file` - File to upload (required)
- `parent_id` - Parent folder ID (optional)
- `path` - Target path (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "file_123",
    "name": "uploaded_file.pdf",
    "size": 1024,
    "mimeType": "application/pdf"
  }
}
```

## Move Files

### POST `/api/files/move`

Move files/folders.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "parentId": "target_folder_id"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files moved successfully"
}
```

## Copy Files

### POST `/api/files/copy`

Copy files/folders.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "parentId": "target_folder_id"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files copied successfully"
}
```

## Rename File

### POST `/api/files/rename`

Rename file/folder.

**Request Body:**

```json
{
  "id": "file_123",
  "name": "New Name"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "file_123",
    "name": "New Name"
  }
}
```

## Star Files

### POST `/api/files/star`

Star/unstar files.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "starred": true
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files starred"
}
```

## Get Starred Files

### GET `/api/files/starred`

List starred files.

**Query Parameters:**

- `sortBy` - Sort field (optional)
- `order` - Sort order (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "files": [ ... ]
  }
}
```

## Share Files

### POST `/api/files/share`

Share/unshare files.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"],
  "shared": true
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "shareLink": "http://example.com/s/token123"
  }
}
```

## Get Shared Files

### GET `/api/files/shared`

List files shared by current user.

**Query Parameters:**

- `sortBy` - Sort field (optional)
- `order` - Sort order (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "files": [ ... ]
  }
}
```

## Delete Files

### POST `/api/files/delete`

Move files to trash.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files moved to trash"
}
```

## Get Trash

### GET `/api/files/trash`

List files in trash.

**Query Parameters:**

- `sortBy` - Sort field (optional)
- `order` - Sort order (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "files": [ ... ]
  }
}
```

## Restore Files

### POST `/api/files/trash/restore`

Restore files from trash.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files restored"
}
```

## Permanent Delete

### POST `/api/files/trash/delete`

Permanently delete files.

**Request Body:**

```json
{
  "ids": ["file_123", "file_456"]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Files permanently deleted"
}
```

## Download File

### GET `/api/files/:id/download`

Download file or folder (folders return ZIP).

**Response:**
File download or ZIP archive

## File Events

### GET `/api/files/events`

Real-time file events stream (Server-Sent Events). Requires Redis.

**Response:**
Server-Sent Events stream

## Related Topics

- [Sharing](sharing.md) - Share link endpoints
- [File System Concepts](/concepts/file-system) - File system overview
