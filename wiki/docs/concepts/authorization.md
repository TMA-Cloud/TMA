# Authorization

Authorization and access control in TMA Cloud.

## User Roles

### Administrator

The first user to sign up automatically becomes an administrator with:

- Full system access
- User management
- Storage limit configuration
- Signup control
- MFA management
- Custom drive configuration
- OnlyOffice settings
- System settings

### Regular User

Standard users can:

- Manage their own files
- Create share links
- Configure their own MFA
- View their own storage usage

## Access Control

### File Access

- Users can only access their own files
- Share links provide public access to specific files
- No cross-user file access

### API Access

- Most endpoints require authentication
- Admin-only endpoints check user role
- Rate limiting applies to all endpoints

### Share Links

- Public access without authentication
- Token-based access control
- Optional expiration dates

## Permission Model

### File Permissions

- **Owner:** Full control (read, write, delete, share)
- **Public (via share link):** Read-only access

### Administrative Permissions

- **User Management:** Create, edit, delete users
- **Storage Limits:** Set per-user storage limits
- **System Settings:** Configure global settings

## Security Considerations

- All file operations are user-scoped
- Share links use cryptographically secure tokens
- Admin operations are logged in audit trail
- Session-based authorization checks

## Related Topics

- [Authentication](authentication.md) - How users authenticate
- [Security Model](security-model.md) - Overall security architecture
- [Sharing Model](sharing-model.md) - How file sharing works
