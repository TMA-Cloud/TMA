# Sharing API

Share link endpoints for TMA Cloud.

**Note:** All public sharing endpoints are rate-limited to 100 requests per 15 minutes per IP address to prevent abuse.

## Share Links (Public)

### GET `/s/:token`

View shared files/folders.

**Validation:**

- `token`: Required. Must be a non-empty string.

**Responses:**

- **200** - HTML page with shared files
- **404** - Link does not exist or has been removed
- **410** - Link has expired

### GET `/s/:token/file/:id`

Download a file from a share link.

**Validation:**

- `token`: Required. Must be a non-empty string.
- `id`: Required. Must be a non-empty string.

**Responses:**

- **200** - File download
- **404** - Link or file not found
- **410** - Link has expired

### GET `/s/:token/zip`

Download a folder as ZIP from a share link.

**Validation:**

- `token`: Required. Must be a non-empty string.

**Responses:**

- **200** - ZIP archive download
- **404** - Link not found or not a folder
- **410** - Link has expired

## Related Topics

- [Files](files.md) - File management endpoints
- [Sharing Model](/concepts/sharing-model) - How sharing works
