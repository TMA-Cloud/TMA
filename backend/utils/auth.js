/**
 * Authentication utility functions
 */

const { logger } = require('../config/logger');

// Security check: warn if running in production without HTTPS
if (process.env.NODE_ENV === 'production' && process.env.FORCE_INSECURE_COOKIES === 'true') {
  logger.warn('[SECURITY] Running in production with FORCE_INSECURE_COOKIES=true. Cookies will not have secure flag. This is insecure!');
}

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
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
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
 * @param {string} expiresIn - Token expiration (default: '7d')
 * @returns {string} JWT token
 */
function generateAuthToken(userId, jwtSecret, expiresIn = '7d') {
  const jwt = require('jsonwebtoken');
  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign({ id: userId }, jwtSecret, { expiresIn, algorithm: 'HS256' });
}

module.exports = {
  getCookieOptions,
  isValidEmail,
  isValidPassword,
  generateAuthToken,
};

