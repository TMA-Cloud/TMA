# Authentication Issues

Troubleshooting authentication problems.

## Login Problems

### Cannot Login

**Check:**

1. Verify email and password are correct
2. Check if account exists
3. Verify signup is enabled (if creating new account)
4. Check for rate limiting (5 attempts per 15 minutes)

### MFA Issues

**Problems:**

- MFA code not working
- QR code not displaying
- Cannot disable MFA

**Solutions:**

1. Verify time sync on device (TOTP requires accurate time)
2. Check MFA secret is correct
3. Ensure MFA is properly enabled after setup
4. Contact admin if MFA needs to be reset (admin cannot disable user MFA)

## Session Issues

### Sessions Not Persisting

**Check:**

1. Verify cookies are enabled
2. Check `httpOnly` cookie settings
3. Verify JWT token is being set
4. Check browser console for errors

### Logout Issues

**Problems:**

- Cannot logout
- Sessions not revoking

**Solutions:**

1. Clear browser cookies
2. Use "Logout All" option
3. Check session management endpoint

## Token Issues

### Token Expired

**Solutions:**

1. Login again to get new token
2. Check token expiration settings
3. Verify system time is correct

### Invalid Token

**Solutions:**

1. Clear cookies and login again
2. Check JWT_SECRET is set correctly
3. Verify token format

## Related Topics

- [Common Errors](common-errors.md) - General troubleshooting
- [Authentication API](/api/authentication) - API endpoints
- [Authentication Concepts](/concepts/authentication) - How auth works
