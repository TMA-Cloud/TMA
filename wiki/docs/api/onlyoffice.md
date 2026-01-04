# OnlyOffice API

OnlyOffice integration endpoints for TMA Cloud.

## Editor Configuration

### GET `/api/onlyoffice/config/:id`

Get OnlyOffice editor configuration for a file.

**Response:**

```json
{
  "success": true,
  "data": {
    "document": {
      "fileType": "docx",
      "key": "file_key",
      "title": "document.docx",
      "url": "https://example.com/api/onlyoffice/file/123"
    },
    "editorConfig": {
      "mode": "edit",
      "callbackUrl": "https://example.com/api/onlyoffice/callback"
    }
  }
}
```

## Viewer

### GET `/api/onlyoffice/viewer/:id`

Get standalone viewer page for a file.

**Response:**
HTML page with OnlyOffice viewer

## File Serving

### GET `/api/onlyoffice/file/:id`

Serve file to OnlyOffice server (requires signed token).

**Response:**
File content

## Callback

### POST `/api/onlyoffice/callback`

OnlyOffice callback endpoint.

**Request Body:**
OnlyOffice callback data

**Response:**

```json
{
  "success": true
}
```

## Related Topics

- [Files](files.md) - File management
- [OnlyOffice Integration](/concepts/architecture) - Architecture overview
