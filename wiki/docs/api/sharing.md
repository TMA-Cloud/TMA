# Sharing API

Share link endpoints for TMA Cloud.

**Note:** All public sharing endpoints are rate-limited to 100 requests per 15 minutes per IP address to prevent abuse.

## Share Links (Public)

### GET `/s/:token`

View shared files/folders.

**Response:**
HTML page with shared files

### GET `/s/:token/file/:id`

Download a file from a share link.

**Response:**
File download

### GET `/s/:token/zip`

Download a folder as ZIP from a share link.

**Response:**
ZIP archive download

## Related Topics

- [Files](files.md) - File management endpoints
- [Sharing Model](/concepts/sharing-model) - How sharing works
