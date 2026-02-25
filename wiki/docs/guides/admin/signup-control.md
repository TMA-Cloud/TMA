# Signup Control

Control user registration in TMA Cloud (admin only).

## Enable/Disable Signup

1. Go to **Settings**
2. Open the **Administration** section (visible only to the first user)
3. Use the **Allow User Signup** toggle
4. Changes apply immediately

**When enabled:** Anyone can create an account. First user to sign up becomes admin.

**When disabled:** Only the first user (admin) can allow to create accounts; public signup is blocked.

## Hide File Extensions

1. Go to **Settings**
2. Open the **Administration** section (visible only to the first user)
3. Use the **Hide file extensions** toggle
4. Changes apply immediately for all users

**When on:** File names in the file manager and in the rename dialog are shown without extensions.

**When off:** File names show with extensions (default).

## First User

- The first user to sign up is the administrator
- Only this user sees the Administration section and the signup toggle
- First user ID is stored in `app_settings.first_user_id` and is immutable
- Admin status is enforced on the server; the client cannot override it

## Use Cases

- **Public:** Enable signup for self-registration; monitor users in Settings → Registered Users
- **Private:** Disable signup; no one is allowed to signup

## Related Topics

- [User Management](user-management.md) - Manage users
- [First Login](/getting-started/first-login) - Create first account
- [Authentication](/concepts/authentication) - Authentication system
