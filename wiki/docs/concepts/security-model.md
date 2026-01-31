# Security Model

Overall security architecture and practices in TMA Cloud.

## Authentication Security

### Password Security

- **Hashing:** bcrypt with salt rounds
- **Storage:** Hashed passwords only
- **Validation:** Strong password requirements

### Token Security

- **JWT Tokens:** Signed and verified
- **httpOnly Cookies:** Prevents XSS attacks
- **Expiration:** Automatic token expiration
- **Versioning:** Token revocation support

### Session Security

- **Session Binding:** Browser fingerprint matching
- **Token Theft Protection:** Invalid tokens on mismatch
- **Active Session Management:** View and revoke sessions
- **Logout All:** Invalidate all tokens

## Authorization Security

### Access Control

- **User Isolation:** Users can only access their files
- **Role-Based:** Admin vs regular user permissions
- **API Authorization:** Endpoint-level checks
- **Share Link Security:** Token-based access

### Input Validation

All incoming data from clients is strictly validated and sanitized on the backend to protect against a wide range of attacks.

- **Schema-Based Validation:** The application uses `express-validator` to enforce strict, declarative validation rules for all API endpoints.
- **Centralized Schemas:** Validation schemas are centrally managed, ensuring consistency and making the rules easy to audit and maintain.
- **Sanitization:** In addition to validation, all user-provided input is sanitized to neutralize potentially malicious content (e.g., stripping HTML tags, normalizing email addresses).
- **Strong Typing:** Rules include strict type checks, length limits, and format validation (e.g., for emails, URLs, and file names).
- **Protection Measures:** This approach provides a strong defense against common vulnerabilities such as:
  - SQL Injection (in combination with parameterized queries)
  - Cross-Site Scripting (XSS)
  - Path Traversal
  - Insecure Deserialization
- **MIME Type Validation:** For file uploads, the actual file content (magic bytes) is verified to match its declared MIME type, preventing content spoofing attacks.

## Data Security

### File Storage

- **User Isolation:** Files stored per-user
- **Path Validation:** Prevents directory traversal
- **Access Control:** Database-level checks
- **MIME Type Detection:** Actual file type detected from content (magic bytes)
- **MIME Type Validation:** File content must match declared type

### File Encryption

- **Algorithm:** AES-256-GCM authenticated encryption
- **Scope:** Files in `UPLOAD_DIR`
- **Key Management:** Environment variable configuration
- **Stream Processing:** Memory-efficient for large files
- **Automatic:** Encryption on upload, decryption on download

### Database Security

- **Parameterized Queries:** SQL injection prevention
- **Connection Security:** SSL support
- **Credential Protection:** Environment variables

## Network Security

### HTTPS

- **Recommended:** Use HTTPS in production
- **Cookie Security:** Secure flag for cookies
- **Headers:** Security headers configured
- **S3 (when STORAGE_DRIVER=s3):** Bucket policy can enforce HTTPS-only access; run `npm run s3:policy-https` or `npm run s3:protect-all` from backend (see [Storage Management](/concepts/storage-management)).

### Rate Limiting

The API employs rate limiting to prevent abuse and ensure service stability. Different limits are applied to authentication, file uploads, and general API endpoints. For detailed information, see the [Rate Limits](/reference/rate-limits) reference.

## Audit & Logging

### Audit Trail

- **Comprehensive Logging:** All critical operations
- **Queue-Based:** Async audit event processing
- **Retention:** Configurable retention periods
- **Query Support:** Search and filter audit logs

### Logging Security

- **Secret Masking:** Automatic redaction
- **Structured Logs:** JSON format for analysis
- **Request Tracking:** Request ID propagation
- **Error Logging:** Detailed error information

## Security Headers

- **CSP:** Content Security Policy
- **X-Frame-Options:** Prevent clickjacking
- **X-Content-Type-Options:** MIME type sniffing prevention
- **X-XSS-Protection:** XSS protection
- **Referrer-Policy:** Referrer information control
- **Permissions-Policy:** Feature permissions

## Best Practices

### For Administrators

- Use strong passwords
- Enable MFA
- Regularly review audit logs
- Keep software updated
- Use HTTPS in production

### For Users

- Use strong passwords
- Enable MFA for additional security
- Review active sessions regularly
- Be cautious with share links

## Related Topics

- [Authentication](authentication.md) - Authentication system
- [Authorization](authorization.md) - Access control
- [Audit Logs](/guides/operations/audit-logs) - Audit system
- [Security Features](/reference/error-codes) - Error handling
