# Authentication

Authentication system overview for TMA Cloud.

## Authentication Methods

TMA Cloud supports multiple authentication methods:

### Email/Password Authentication

- Secure password hashing with bcrypt
- JWT token-based sessions
- httpOnly cookies for token storage
- Session binding (browser fingerprint)

### Google OAuth (Optional)

- OAuth 2.0 integration
- Automatic account creation
- Linked to email/password accounts

### Multi-Factor Authentication (MFA)

- TOTP-based (Time-based One-Time Password)
- QR code setup
- Optional per-user
- Backup codes as fallback (single-use, replaceable)

## Session Management

### Token Structure

- JWT tokens with expiration
- Token versioning for revocation
- Session binding to prevent hijacking

### Active Sessions

- View all active sessions
- Revoke individual sessions
- Logout from all devices
- Session activity tracking

## Security Features

- **Session Binding:** Browser fingerprint prevents token theft
- **Token Versioning:** Invalidate all tokens on logout-all
- **Rate Limiting:** 25 login/signup attempts per 15 minutes per IP/email; MFA verify/disable 5 attempts per minute; backup code regeneration 3 attempts per 10 minutes with 5-minute cooldown
- **Audit Logging:** All authentication events logged

## First User Privileges

The first user to sign up becomes the administrator with full system access.

## Signup Control

Administrators can enable/disable user registration:

- When enabled: Anyone can create an account
- When disabled: Only admins can create accounts

## Related Topics

- [Authorization](authorization.md) - Access control and permissions
- [Security Model](security-model.md) - Overall security architecture
- [API: Authentication](/api/authentication) - API endpoints
