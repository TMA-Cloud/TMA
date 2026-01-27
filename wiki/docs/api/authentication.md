# Authentication API

Authentication endpoints for TMA Cloud.

## Signup

### POST `/api/signup`

Create new user account. Respects signup enabled/disabled setting.

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securepassword",
  "name": "User Name"
}
```

**Response:**

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

Authenticate user and receive JWT token. If MFA is enabled, requires `mfaCode` in request.

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securepassword",
  "mfaCode": "123456" // Optional, required if MFA enabled
}
```

**Response:**

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

Log out current user (clears token cookie).

**Response:**

```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Rate limiting:** 100 requests per 15 minutes.

### POST `/api/logout-all`

Log out from all devices by invalidating all tokens.

**Response:**

```json
{
  "success": true,
  "message": "Logged out from all devices"
}
```

**Rate limiting:** 100 requests per 15 minutes.

## Profile

### GET `/api/profile`

Get current user profile.

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

**Rate limiting:** 100 requests per 15 minutes.

## Google OAuth

### GET `/api/google/enabled`

Check if Google OAuth is enabled.

**Response:**

```json
{
  "enabled": true
}
```

### GET `/api/google/login`

Initiate Google OAuth login (redirects to Google).

### GET `/api/google/callback`

Google OAuth callback endpoint.

**Rate limiting:** 5 attempts per 15 minutes.

## Multi-Factor Authentication

### GET `/api/mfa/status`

Get MFA status for current user.

**Response:**

```json
{
  "enabled": false
}
```

**Rate limiting:** 100 requests per 15 minutes.

### POST `/api/mfa/setup`

Generate MFA secret and QR code for setup.

**Response:**

```json
{
  "secret": "MFA_SECRET",
  "qrCode": "data:image/png;base64,..."
}
```

**Rate limiting:** 100 requests per 15 minutes.

### POST `/api/mfa/verify`

Verify MFA code and enable MFA.

**Request Body:**

```json
{
  "code": "123456"
}
```

**Response:**

```json
{
  "success": true,
  "message": "MFA enabled successfully",
  "backupCodes": ["ABCD2345", "EFGH6789"], // present on success
  "shouldPromptSessions": true // prompt to sign out other sessions
}
```

**Rate limiting:** 5 attempts per minute per IP/user (MFA-specific limiter).

### POST `/api/mfa/disable`

Disable MFA. Requires verification code.

**Request Body:**

```json
{
  "code": "123456"
}
```

**Response:**

```json
{
  "success": true,
  "message": "MFA disabled successfully"
}
```

**Rate limiting:** 5 attempts per minute per IP/user (MFA-specific limiter).

### POST `/api/mfa/backup-codes/regenerate`

Regenerate MFA backup codes (invalidates existing codes).

**Response:**

```json
{
  "backupCodes": ["ABCD2345", "EFGH6789"]
}
```

**Error Response (429 Too Many Requests):**

When cooldown is active or rate limit exceeded:

```json
{
  "message": "Please wait 3 minutes and 45 seconds before regenerating backup codes again",
  "retryAfterMs": 225000
}
```

**Rate limiting:** 3 attempts per 10 minutes per user.

**Cooldown:** 5 minutes between regenerations per user.

Codes auto-download on the client after regeneration.

### GET `/api/mfa/backup-codes/count`

Get remaining unused backup code count.

**Response:**

```json
{
  "count": 7
}
```

**Rate limiting:** 100 requests per 15 minutes.

## Related Topics

- [Sessions](sessions.md) - Session management
- [Authentication Concepts](/concepts/authentication) - Authentication overview
