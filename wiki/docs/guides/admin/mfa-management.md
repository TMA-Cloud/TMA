# MFA Management

Manage multi-factor authentication in TMA Cloud (admin only).

## MFA Overview

### TOTP-Based MFA

- Time-based One-Time Password
- QR code setup
- Backup codes support
- Optional per-user

## Admin Capabilities

### View MFA Status

- See which users have MFA enabled
- Monitor MFA adoption
- View MFA statistics

### MFA Configuration

- Cannot enable MFA for users (user must do it)
- Cannot disable user MFA (user must do it)
- Monitor MFA usage

## User MFA Setup

### User-Initiated

- Users enable MFA themselves
- QR code generation
- Verification required
- Backup codes provided

### MFA Disable

- Users can disable their own MFA
- Requires verification code
- Admin cannot disable user MFA

## Best Practices

- Encourage MFA adoption
- Monitor MFA usage
- Provide support for setup
- Document MFA benefits

## Security Considerations

- MFA significantly improves security
- Recommended for all users
- Especially important for admins
- Protects against password theft

## Related Topics

- [User Management](user-management.md) - Manage users
- [Authentication](/concepts/authentication) - Authentication system
- [Security Model](/concepts/security-model) - Security overview
