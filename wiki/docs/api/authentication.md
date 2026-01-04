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
  "success": true,
  "data": {
    "user": { ... },
    "token": "jwt_token"
  }
}
```

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
  "success": true,
  "data": {
    "user": { ... },
    "token": "jwt_token"
  }
}
```

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

### POST `/api/logout-all`

Log out from all devices by invalidating all tokens.

**Response:**

```json
{
  "success": true,
  "message": "Logged out from all devices"
}
```

## Profile

### GET `/api/profile`

Get current user profile.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "User Name",
    "mfaEnabled": false,
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

## Google OAuth

### GET `/api/google/enabled`

Check if Google OAuth is enabled.

**Response:**

```json
{
  "success": true,
  "data": {
    "enabled": true
  }
}
```

### GET `/api/google/login`

Initiate Google OAuth login (redirects to Google).

### GET `/api/google/callback`

Google OAuth callback endpoint.

## Multi-Factor Authentication

### GET `/api/mfa/status`

Get MFA status for current user.

**Response:**

```json
{
  "success": true,
  "data": {
    "enabled": false
  }
}
```

### POST `/api/mfa/setup`

Generate MFA secret and QR code for setup.

**Response:**

```json
{
  "success": true,
  "data": {
    "secret": "MFA_SECRET",
    "qrCode": "data:image/png;base64,..."
  }
}
```

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
  "message": "MFA enabled successfully"
}
```

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

## Related Topics

- [Sessions](sessions.md) - Session management
- [Authentication Concepts](/concepts/authentication) - Authentication overview
