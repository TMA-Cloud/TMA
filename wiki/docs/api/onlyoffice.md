# OnlyOffice API

OnlyOffice integration endpoints for TMA Cloud.

## Editor Configuration

### GET `/api/onlyoffice/config/:id`

Get OnlyOffice editor configuration for a file.

**Rate limiting:** General API limit (10000 per 15 minutes per IP).

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

**Rate limiting:** General API limit (10000 per 15 minutes per IP).

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

**Rate limiting:** General API limit (10000 per 15 minutes per IP).

**Response:**
File content

## Callback

### POST `/api/onlyoffice/callback`

OnlyOffice callback endpoint. Called by the OnlyOffice Document Server when document state changes.

**Request Body:**
OnlyOffice callback data including `status`, `key`, `url`, and `forcesavetype`.

**Callback Statuses:**

| Status | Meaning                                                   |
| ------ | --------------------------------------------------------- |
| 0      | Document is being edited                                  |
| 2      | Document is ready for saving (all users closed)           |
| 3      | Document saving error                                     |
| 4      | Document closed with no changes                           |
| 6      | Document is being edited, current state saved (forcesave) |

**Forcesave Types (when status = 6):**

| Type | Trigger                                     |
| ---- | ------------------------------------------- |
| 0    | Command service request (auto-save service) |
| 1    | Save button click (Ctrl+S)                  |
| 2    | Timer-based (autoAssembly)                  |
| 3    | Form submission                             |

**Response:**

```json
{
  "error": 0
}
```

**Note:** `error: 0` must always be returned, even on internal errors. Otherwise OnlyOffice will retry indefinitely.

## Auto-Save

Documents are saved to storage periodically while being edited, not just on close.

**How it works:**

1. When a document is opened (via viewer or config endpoint), it is registered with the auto-save service.
2. Every 30 seconds, the backend sends a `forcesave` command to the OnlyOffice Document Server command service API (`/coauthoring/CommandService.ashx`).
3. OnlyOffice responds by calling the callback endpoint with status 6 and `forcesavetype: 0`.
4. The callback handler downloads the current document and writes it to storage.
5. When all users close the document (status 2 or 4), it is unregistered from auto-save.

**Editor configuration:**

The editor config includes `customization.forcesave: true`, which also allows manual saves via Ctrl+S or the save button without closing the document.

**Command service request format:**

```json
{
  "c": "forcesave",
  "key": "userId-fileId-timestamp"
}
```

When JWT is enabled, the payload is signed and sent as `{ "token": "signed_jwt" }`.

**Files:**

- `backend/services/onlyofficeAutoSave.js` - Auto-save service
- `backend/controllers/onlyoffice/onlyoffice.callback.controller.js` - Callback handler

## Related Topics

- [Files](files.md) - File management
- [OnlyOffice Integration](/concepts/architecture) - Architecture overview
- [OnlyOffice Issues](/debugging/onlyoffice-issues) - Troubleshooting
