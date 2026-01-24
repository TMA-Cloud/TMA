# Agent API

HTTP endpoints exposed by the `tma-agent` process for custom drive operations.

All authenticated endpoints expect the agent token in the `Authorization` header as either `Bearer <token>` or plain `<token>`. If no token is configured, requests are accepted without authentication.

## Health

### GET `/health`

Simple health check for the agent process. No authentication required.

**Response:**

```json
{
  "status": "ok"
}
```

## Version

### GET `/version`

Get the running agent version.

**Response:**

```json
{
  "agent": "1.0.1"
}
```

## List Configured Paths

### GET `/api/paths`

Return the list of drive paths configured in `tma-agent.json`.

**Response:**

```json
{
  "paths": ["/mnt/storage", "/data/drive"]
}
```

## List Directory

### GET `/api/list`

List files and folders under a given absolute path.

**Query Parameters:**

- `path` (required) — Absolute path inside one of the configured drive paths

**Response:**

```json
{
  "files": [
    {
      "name": "example.txt",
      "path": "/mnt/storage/example.txt",
      "size": 1234,
      "isDir": false,
      "modTime": "2024-01-01T00:00:00Z"
    }
  ],
  "path": "/mnt/storage"
}
```

If the path is not a directory, the agent returns an error.

## Read File

### GET `/api/read`

Stream a file from disk.

**Query Parameters:**

- `path` (required) — Absolute file path inside a configured drive path

**Response:**

- Raw file bytes in the response body
- `Content-Type: application/octet-stream`
- `Content-Disposition` set to the file name

If the path is a directory, the agent returns an error and suggests using `/api/list` instead.

## Write File

### POST `/api/write`

Create or replace a file by streaming the request body.

**Query Parameters:**

- `path` (required) — Absolute file path inside a configured drive path

**Request:**

- Raw file bytes in the request body

**Response:**

```json
{
  "status": "written",
  "path": "/mnt/storage/example.txt",
  "size": 1234
}
```

Parent directories are created automatically if they do not exist. Request size is limited by the agent configuration.

## Rename

### POST `/api/rename`

Rename or move a file or directory using OS-level rename.

**Request Body:**

```json
{
  "oldPath": "/mnt/storage/old-name.txt",
  "newPath": "/mnt/storage/new-name.txt"
}
```

Both paths must be absolute and remain inside configured drive paths.

**Response:**

```json
{
  "status": "renamed",
  "oldPath": "/mnt/storage/old-name.txt",
  "newPath": "/mnt/storage/new-name.txt"
}
```

## Delete

### DELETE `/api/delete`

Delete a file or directory.

**Query Parameters:**

- `path` (required) — Absolute path to delete

**Response:**

```json
{
  "status": "deleted",
  "path": "/mnt/storage/example.txt"
}
```

For directories, deletion is recursive.

## Stat

### GET `/api/stat`

Get basic metadata for a file or directory.

**Query Parameters:**

- `path` (required) — Absolute path to inspect

**Response:**

```json
{
  "name": "example.txt",
  "path": "/mnt/storage/example.txt",
  "size": 1234,
  "isDir": false,
  "modTime": "2024-01-01T00:00:00Z"
}
```

## Disk Usage

### GET `/api/usage`

Get filesystem disk usage statistics for a path. Returns the actual disk space of the mounted volume, not the Docker host's space.

**Query Parameters:**

- `path` (required) — Absolute path inside one of the configured drive paths

**Response:**

```json
{
  "total": 107374182400,
  "free": 53687091200,
  "used": 53687091200
}
```

- `total` — Total disk space in bytes
- `free` — Available disk space in bytes (available to unprivileged users)
- `used` — Used disk space in bytes

In Docker environments, this endpoint returns the filesystem statistics for the specific mounted volume, ensuring accurate disk space reporting for custom drives.

## Make Directory

### POST `/api/mkdir`

Create a directory (and any missing parent directories).

**Query Parameters:**

- `path` (required) — Absolute directory path

**Response:**

```json
{
  "status": "created",
  "path": "/mnt/storage/new-folder"
}
```

If the directory already exists, the agent returns success without error.

## File Watching and Webhooks

### POST `/api/watch`

Start watching a directory tree for file system changes and (optionally) configure a webhook.

**Request Body:**

```json
{
  "path": "/mnt/storage",
  "webhookUrl": "https://example.com/agent-webhook",
  "webhookToken": "optional-secret"
}
```

- `path` (required) — Absolute directory inside a configured drive path
- `webhookUrl` (optional) — URL to receive change notifications
- `webhookToken` (optional) — Token sent as `Authorization: Bearer <token>` to the webhook

**Response:**

```json
{
  "status": "watching",
  "path": "/mnt/storage"
}
```

When a watched path changes, the agent sends a JSON payload:

```json
{
  "event": "create",
  "path": "/mnt/storage/example.txt",
  "isDir": false,
  "size": 1234,
  "modTime": "2024-01-01T00:00:00Z"
}
```

- `event` — One of `create`, `write`, `remove`, `rename`, `chmod`
- `path` — File or directory path reported by the watcher
- `isDir` — Whether the path is a directory
- `size` — File size in bytes (0 for directories or when not available)
- `modTime` — Last modification time

### POST `/api/unwatch`

Stop watching a directory tree.

**Request Body:**

```json
{
  "path": "/mnt/storage"
}
```

**Response:**

```json
{
  "status": "unwatched",
  "path": "/mnt/storage"
}
```
