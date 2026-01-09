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

- **Sanitization:** All user input sanitized
- **Type Checking:** Parameter validation
- **Path Traversal Protection:** Prevent directory traversal
- **SQL Injection Protection:** Parameterized queries

## Data Security

### File Storage

- **User Isolation:** Files stored per-user
- **Path Validation:** Prevents directory traversal
- **Access Control:** Database-level checks

### File Encryption

- **Algorithm:** AES-256-GCM authenticated encryption
- **Scope:** Files in `UPLOAD_DIR` (custom drive files excluded)
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

### Rate Limiting

- **Auth Endpoints:** 5 attempts per 15 minutes
- **API Endpoints:** 100 requests per 15 minutes
- **Upload Endpoints:** 50 uploads per hour

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
