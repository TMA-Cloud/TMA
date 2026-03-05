/**
 * Authentication utility functions
 */

const { logger } = require('../config/logger');

/** True when production is served over HTTP (BACKEND_URL starts with http:// or FORCE_INSECURE_COOKIES) */
function isProductionOverHttp() {
  if (process.env.NODE_ENV !== 'production') return false;
  if (process.env.FORCE_INSECURE_COOKIES === 'true') return true;
  const url = process.env.BACKEND_URL || '';
  return url.toLowerCase().startsWith('http://');
}

// One-time warn when production uses non-secure cookies (HTTP)
if (process.env.NODE_ENV === 'production') {
  if (process.env.FORCE_INSECURE_COOKIES === 'true') {
    logger.warn(
      '[SECURITY] FORCE_INSECURE_COOKIES=true: auth cookies will not use Secure flag. Use only for HTTP deployments.'
    );
  } else if ((process.env.BACKEND_URL || '').toLowerCase().startsWith('http://')) {
    logger.warn('[SECURITY] BACKEND_URL is HTTP: auth cookies will not use Secure flag so login works over HTTP.');
  }
}

/**
 * Get cookie options for JWT tokens
 * In production over HTTPS we set secure: true so the browser only sends the cookie over HTTPS.
 * In production over HTTP (BACKEND_URL=http://... or FORCE_INSECURE_COOKIES=true) we set secure: false so the cookie is sent over HTTP.
 * @returns {Object} Cookie options
 */
function getCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  const overHttp = isProductionOverHttp();
  const secure = isProduction && !overHttp;

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
 * Generate JWT authentication token for a user
 * @param {string} userId - User ID to encode in the token
 * @param {string} jwtSecret - JWT secret key
 * @param {Object} options - Additional options
 * @param {number} options.tokenVersion - User's current token version
 * @param {string} options.sessionId - Session ID to bind token to
 * @param {string} options.expiresIn - Token expiration (default: '7d')
 * @returns {string} JWT token
 */
function generateAuthToken(userId, jwtSecret, options = {}) {
  const jwt = require('jsonwebtoken');
  const { tokenVersion = 1, sessionId = null, expiresIn = '7d' } = options;

  const payload = {
    id: userId,
    v: tokenVersion, // Token version for session invalidation
  };

  // Add session ID if provided (for individual session revocation)
  if (sessionId) {
    payload.sid = sessionId;
  }

  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign(payload, jwtSecret, { expiresIn, algorithm: 'HS256' });
}

module.exports = {
  getCookieOptions,
  isValidEmail,
  isValidPassword,
  generateAuthToken,
};
