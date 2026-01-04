# Error Handling

Error responses and codes for TMA Cloud API.

## Error Response Format

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

## Common Error Codes

### Authentication Errors

- `UNAUTHORIZED` - Authentication required
- `INVALID_CREDENTIALS` - Invalid email or password
- `MFA_REQUIRED` - MFA code required
- `INVALID_MFA_CODE` - Invalid MFA code
- `TOKEN_EXPIRED` - JWT token expired
- `TOKEN_INVALID` - Invalid JWT token

### Authorization Errors

- `FORBIDDEN` - Insufficient permissions
- `ADMIN_REQUIRED` - Admin access required

### Validation Errors

- `VALIDATION_ERROR` - Request validation failed
- `MISSING_FIELD` - Required field missing
- `INVALID_FORMAT` - Invalid data format

### File Errors

- `FILE_NOT_FOUND` - File does not exist
- `STORAGE_LIMIT_EXCEEDED` - Storage limit reached
- `UPLOAD_FAILED` - File upload failed
- `INVALID_FILE_TYPE` - Unsupported file type

### System Errors

- `INTERNAL_ERROR` - Internal server error
- `DATABASE_ERROR` - Database operation failed
- `SERVICE_UNAVAILABLE` - Service temporarily unavailable

## HTTP Status Codes

- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Server Error

## Error Handling Best Practices

- Check `success` field first
- Handle specific error codes
- Display user-friendly messages
- Log errors for debugging

## Related Topics

- [Error Codes Reference](/reference/error-codes) - Complete error code list
- [Debugging](/debugging/common-errors) - Troubleshooting
