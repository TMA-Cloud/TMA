# Signup Control

Control user registration in TMA Cloud (admin only).

## Signup Settings

### Enable/Disable Signup

1. Navigate to **Settings** → **Signup Control**
2. Toggle signup on/off
3. Save changes

### When Enabled

- Anyone can create an account
- Public registration available
- First user becomes admin

### When Disabled

- Only admins can create accounts
- Public registration blocked
- Manual account creation required

## First User Privileges

### Automatic Admin

- First user to sign up becomes admin
- Full system access
- Can control signup

### Immutable Setting

- First user ID stored permanently
- Cannot be changed
- Ensures system security

## Use Cases

### Public Deployment

- Enable signup for public access
- Allow self-registration
- Monitor new users

### Private Deployment

- Disable signup for private use
- Manual account creation only
- Controlled access

## Best Practices

- Disable signup for private deployments
- Enable signup for public deployments
- Regularly review user list
- Monitor new registrations

## Related Topics

- [User Management](user-management.md) - Manage users
- [First Login](/getting-started/first-login) - Create first account
- [Authentication](/concepts/authentication) - Authentication system
