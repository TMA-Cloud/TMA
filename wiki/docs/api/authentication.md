# Authentication API

Authentication endpoints for TMA Cloud.

## Signup

### POST `/api/signup`

Create a new user account. This endpoint respects the server's signup enabled/disabled setting.

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securepassword",
  "name": "User Name"
}
```

**Validation:**

- `email`: Must be a valid email format and not exceed 254 characters.
- `password`: Must be between 6 and 128 characters.
- `name`: Optional. Must not exceed 100 characters.

**Response:**

The user object for the created account.

```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

**Note:** The JWT token is set as an httpOnly cookie named `token`.

**Rate limiting:** 5 attempts per 15 minutes.

## Login

### POST `/api/login`

Authenticate a user and receive a JWT token. If MFA is enabled for the user, `mfaCode` is required.

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securepassword",
  "mfaCode": "123456" // Optional, required if MFA enabled
}
```

**Validation:**

- `email`: Must be a valid email format.
- `password`: Must not exceed 128 characters.

**Response:**

The authenticated user's object.

```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

**Note:** The JWT token is set as an httpOnly cookie named `token`.

**Rate limiting:** 5 attempts per 15 minutes.

## Logout

### POST `/api/logout`

Log out the current user by clearing the authentication token cookie.

**Response:**

```json
{
  "message": "Logged out"
}
```

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

### POST `/api/logout-all`

Log out from all devices by invalidating all of the user's active sessions and tokens.

**Response:**

```json
{
  "message": "Successfully logged out from all devices",
  "sessionsInvalidated": true
}
```

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

## Profile

### GET `/api/profile`

Get the current authenticated user's profile.

**Response:**

```json
{
  "id": "user_123",
  "email": "user@example.com",
  "name": "User Name",
  "mfaEnabled": false,
  "createdAt": "2024-01-01T00:00:00Z"
}
```

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

## Google OAuth

### GET `/api/google/enabled`

Check if Google OAuth is configured and enabled on the server.

**Response:**

```json
{
  "enabled": true
}
```

### GET `/api/google/login`

Initiate the Google OAuth login flow. This will redirect the user to Google's authentication page.

### GET `/api/google/callback`

The callback endpoint for Google to redirect to after successful authentication.

**Rate limiting:** 5 attempts per 15 minutes.

## Multi-Factor Authentication

### GET `/api/mfa/status`

Get the MFA status for the current authenticated user.

**Response:**

```json
{
  "enabled": false
}
```

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

### POST `/api/mfa/setup`

Generate an MFA secret and a corresponding QR code for setup in an authenticator app.

**Response:**

```json
{
  "secret": "MFA_SECRET_IN_BASE32",
  "qrCode": "data:image/png;base64,..."
}
```

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

### POST `/api/mfa/verify`

Verify an MFA code (TOTP) and enable MFA for the user's account.

**Request Body:**

```json
{
  "code": "123456"
}
```

**Validation:**

- `code`: Required. Must be a 6-digit string.

**Response:**

Returns a success message, a new set of backup codes, and a flag to prompt the user to sign out other sessions.

```json
{
  "message": "MFA enabled successfully",
  "backupCodes": ["ABCD-EFGH", "IJKL-MNOP"],
  "shouldPromptSessions": true
}
```

**Rate limiting:** 5 attempts per minute per IP/user.

### POST `/api/mfa/disable`

Disable MFA for the user's account. Requires a valid MFA code (either TOTP or a backup code).

**Request Body:**

```json
{
  "code": "123456"
}
```

**Validation:**

- `code`: Required. Must be a 6-digit (TOTP) or 8-character (backup code) string.

**Response:**

```json
{
  "message": "MFA disabled successfully",
  "shouldPromptSessions": true
}
```

**Rate limiting:** 5 attempts per minute per IP/user.

### POST `/api/mfa/backup-codes/regenerate`

Regenerate MFA backup codes, which invalidates all existing backup codes.

**Response:**

```json
{
  "backupCodes": ["ABCD-EFGH", "IJKL-MNOP"]
}
```

**Error Response (429 Too Many Requests):**

When the cooldown is active or the rate limit is exceeded:

```json
{
  "message": "Please wait 3 minutes and 45 seconds before regenerating backup codes again",
  "retryAfterMs": 225000
}
```

**Rate limiting:** 3 attempts per 10 minutes per user.

**Cooldown:** A 5-minute cooldown period is enforced between regeneration attempts.

**Note:** Backup codes are automatically downloaded on the client after regeneration.

### GET `/api/mfa/backup-codes/count`

Get the number of remaining unused backup codes for the user.

**Response:**

```json
{
  "count": 7
}
```

**Rate limiting:** General API limit (1000 per 15 minutes per IP).

## Related Topics

- [Sessions](sessions.md) - Session management
- [Authentication Concepts](/concepts/authentication) - Authentication overview
