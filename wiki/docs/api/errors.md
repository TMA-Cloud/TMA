# Error Handling

This page describes the error response format for the TMA Cloud API.

## Error Response Format

Error responses use a standard format with a `message` field describing the error.

```json
{
  "message": "Error description"
}
```

### Validation Errors

Validation errors (HTTP status `422`) provide additional detail in a `details` array, specifying which fields failed validation and why.

**Format:**

```json
{
  "message": "Validation failed",
  "details": [
    { "field_name": "Specific error message for the field." },
    { "another_field": "Another specific error." }
  ]
}
```

**Example:**

```json
{
  "message": "Validation failed",
  "details": [
    { "email": "Invalid email format" },
    { "password": "Password must be between 6 and 128 characters" }
  ]
}
```

## Common HTTP Status Codes

- `400 Bad Request`: The request was malformed, such as containing invalid JSON.
- `401 Unauthorized`: Authentication is required and has failed or has not been provided.
- `403 Forbidden`: The authenticated user does not have permission to perform the action.
- `404 Not Found`: The requested resource could not be found.
- `422 Unprocessable Entity`: The request was well-formed but could not be processed due to validation errors. Check the `details` field for more information.
- `429 Too Many Requests`: The user has sent too many requests in a given amount of time.
- `500 Internal Server Error`: An unexpected condition was encountered on the server.
- `503 Service Unavailable`: The server is not ready to handle the request.

### Desktop-only instances

When an instance is configured for desktop app access only, browser requests to main app routes return `403 Forbidden` with:

```json
{
  "message": "This instance is configured for desktop app access only.",
  "error": "DESKTOP_ONLY_ACCESS"
}
```

Share links (`/s/*`) are not affected.

## Error Handling Best Practices

- Rely on the HTTP status code to determine the general nature of the error.
- For `422` validation errors, parse the `details` array to provide specific feedback to the user.
- Display a user-friendly message based on the `message` field.
- Log the full error response for debugging purposes.

## Related Topics

- [API Overview](overview.md) - General API structure and formats.
- [Debugging](/debugging/common-errors) - Troubleshooting common errors.
