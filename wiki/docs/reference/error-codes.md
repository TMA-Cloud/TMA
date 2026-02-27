# Error Codes

Complete reference for all error codes in TMA Cloud API.

## Authentication Errors

- `UNAUTHORIZED` - Authentication required
- `INVALID_CREDENTIALS` - Invalid email or password
- `MFA_REQUIRED` - MFA code required
- `INVALID_MFA_CODE` - Invalid MFA code
- `TOKEN_EXPIRED` - JWT token expired
- `INVALID_TOKEN` - Invalid JWT token (middleware)
- `SESSION_EXPIRED` - Session expired

## Authorization Errors

- `FORBIDDEN` - Insufficient permissions
- `ADMIN_REQUIRED` - Admin access required
- `RESOURCE_OWNER_REQUIRED` - Must be resource owner
- `DESKTOP_ONLY_ACCESS` - Instance is restricted to the desktop app

## Validation Errors

- `VALIDATION_ERROR` - Request validation failed
- `MISSING_FIELD` - Required field missing
- `INVALID_FORMAT` - Invalid data format
- `INVALID_EMAIL` - Invalid email format
- `INVALID_PASSWORD` - Password doesn't meet requirements

## File Errors

- `FILE_NOT_FOUND` - File does not exist
- `FOLDER_NOT_FOUND` - Folder does not exist
- `STORAGE_LIMIT_EXCEEDED` - Storage limit reached
- `UPLOAD_FAILED` - File upload failed
- `INVALID_FILE_TYPE` - Unsupported file type
- `FILE_TOO_LARGE` - File exceeds size limit
- `DUPLICATE_FILE` - File with same name exists

## Share Errors

- `SHARE_NOT_FOUND` - Share link does not exist
- `SHARE_EXPIRED` - Share link has expired
- `SHARE_ACCESS_DENIED` - Access to share denied

## System Errors

- `INTERNAL_ERROR` - Internal server error
- `DATABASE_ERROR` - Database operation failed
- `SERVICE_UNAVAILABLE` - Service temporarily unavailable
- `RATE_LIMIT_EXCEEDED` - Rate limit exceeded

## Middleware / Structural Errors (from error handler)

- `FILE_TOO_LARGE` - Multer file size limit
- `UNEXPECTED_FILE` - Multer unexpected file field
- `DUPLICATE_RESOURCE` - PostgreSQL unique violation (23505)
- `INVALID_REFERENCE` - PostgreSQL foreign key violation (23503)
- `PERMISSION_DENIED` - File system EACCES

**Note:** Many endpoints return only a `message` field; the `error` code is set for the cases above and for JWT/metrics errors.

## Related Topics

- [API Errors](/api/errors) - Error handling
- [Debugging](/debugging/common-errors) - Troubleshooting
