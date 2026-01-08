# MFA Management

Manage multi-factor authentication in TMA Cloud (admin only).

## MFA Overview

### TOTP-Based MFA

- Time-based One-Time Password
- QR code setup
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
- Verification required before enabling
- Backup codes auto-download after MFA is enabled
- Backup codes are one-time use; regenerating invalidates prior codes

### MFA Disable

- Users can disable their own MFA
- Requires verification code
- Admin cannot disable user MFA

### Backup Codes

- Delivered as a downloadable text file on enable or regenerate
- File format includes application name, masked account email, generation date, and usage instructions
- File name: `mfa-backup-codes_TMA-Cloud_YYYY-MM-DD.txt`
- Each code is single-use; dashes are optional when typing codes
- Codes formatted in groups of 5 with numbered brackets
- Regenerate to replace all existing codes
- Cooldown: 5 minutes between regenerations
- Rate limit: 3 attempts per 10 minutes

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
