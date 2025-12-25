/**
 * Authentication utility functions
 */

const crypto = require('crypto');
const { logger } = require('../config/logger');

// Security check: warn if running in production without HTTPS
if (process.env.NODE_ENV === 'production' && process.env.FORCE_INSECURE_COOKIES === 'true') {
  logger.warn(
    '[SECURITY] Running in production with FORCE_INSECURE_COOKIES=true. Cookies will not have secure flag. This is insecure!'
  );
}

// Session binding: when enabled, tokens are bound to client fingerprint
const SESSION_BINDING_ENABLED = process.env.SESSION_BINDING !== 'false';

/**
 * Get cookie options for JWT tokens
 * @returns {Object} Cookie options
 */
function getCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  // In production, always use secure cookies unless explicitly overridden (not recommended)
  const secure = isProduction && process.env.FORCE_INSECURE_COOKIES !== 'true';

  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  };
}

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} True if email is valid
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate password
 * @param {string} password - Password to validate
 * @param {number} minLength - Minimum length (default: 6)
 * @returns {boolean} True if password is valid
 */
function isValidPassword(password, minLength = 6) {
  return password && typeof password === 'string' && password.length >= minLength;
}

/**
 * Generate a client fingerprint hash from request headers
 * This helps detect if a token is being used from a different device/browser
 * @param {Object} req - Express request object
 * @returns {string} Fingerprint hash
 */
function generateClientFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  // Note: We don't include IP address as it changes frequently (mobile networks, VPNs)
  // User-Agent provides reasonable device binding without causing logout issues
  const fingerprint = `${userAgent}`;
  return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}

/**
 * Generate JWT authentication token for a user
 * @param {string} userId - User ID to encode in the token
 * @param {string} jwtSecret - JWT secret key
 * @param {Object} options - Additional options
 * @param {number} options.tokenVersion - User's current token version
 * @param {string} options.sessionId - Session ID to bind token to
 * @param {Object} options.req - Express request object for fingerprinting
 * @param {string} options.expiresIn - Token expiration (default: '7d')
 * @returns {string} JWT token
 */
function generateAuthToken(userId, jwtSecret, options = {}) {
  const jwt = require('jsonwebtoken');
  const { tokenVersion = 1, sessionId = null, req = null, expiresIn = '7d' } = options;

  const payload = {
    id: userId,
    v: tokenVersion, // Token version for session invalidation
  };

  // Add session ID if provided (for individual session revocation)
  if (sessionId) {
    payload.sid = sessionId;
  }

  // Add client fingerprint if request is available and binding is enabled
  if (SESSION_BINDING_ENABLED && req) {
    payload.fp = generateClientFingerprint(req);
  }

  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign(payload, jwtSecret, { expiresIn, algorithm: 'HS256' });
}

/**
 * Validate client fingerprint from token against current request
 * @param {string} tokenFingerprint - Fingerprint stored in token
 * @param {Object} req - Current Express request object
 * @returns {boolean} True if fingerprint matches or binding is disabled
 */
function validateClientFingerprint(tokenFingerprint, req) {
  if (!SESSION_BINDING_ENABLED) {
    return true;
  }
  if (!tokenFingerprint) {
    // Token was issued before fingerprinting was enabled - allow it
    return true;
  }
  const currentFingerprint = generateClientFingerprint(req);
  return tokenFingerprint === currentFingerprint;
}

module.exports = {
  getCookieOptions,
  isValidEmail,
  isValidPassword,
  generateAuthToken,
  generateClientFingerprint,
  validateClientFingerprint,
  SESSION_BINDING_ENABLED,
};
