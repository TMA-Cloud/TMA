/**
 * Authentication utility functions
 */

/**
 * Get cookie options for JWT tokens
 * @returns {Object} Cookie options
 */
function getCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
  return jwt.sign({ id: userId }, jwtSecret, { expiresIn });
}

module.exports = {
  getCookieOptions,
  isValidEmail,
  isValidPassword,
  generateAuthToken,
};

