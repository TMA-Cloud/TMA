# OnlyOffice API

OnlyOffice integration endpoints for TMA Cloud.

## Editor Configuration

### GET `/api/onlyoffice/config/:id`

Get OnlyOffice editor configuration for a file.

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

**Validation:**

- The file `id` from the URL is required.
- The file's extension must be one supported by OnlyOffice.
- The file's actual MIME type must match the expected type for its extension.
- The server will return a `400 Bad Request` if a MIME type mismatch is detected.

**Response:**

```json
{
  "config": {
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
  },
  "token": "signed_jwt_token",
  "onlyofficeJsUrl": "https://onlyoffice.example.com/web-apps/apps/api/documents/api.js"
}
```

## Viewer

### GET `/api/onlyoffice/viewer/:id`

Get standalone viewer page for a file.

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

**Validation:**

- The file `id` from the URL is required.
- The file's extension must be one supported by OnlyOffice.
- The file's actual MIME type must match the expected type for its extension.
- The server will return a `400 Bad Request` (as JSON or HTML) if a MIME type mismatch is detected.

**Response:**
HTML page with OnlyOffice viewer

## File Serving

### GET `/api/onlyoffice/file/:id`

Serve file to OnlyOffice server (requires signed token).

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

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
  "error": 0
}
```

**Note:** OnlyOffice callback format. `error: 0` indicates success.

## Related Topics

- [Files](files.md) - File management
- [OnlyOffice Integration](/concepts/architecture) - Architecture overview
