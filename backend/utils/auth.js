/**
 * Authentication utility functions
 */

import jwt from 'jsonwebtoken';

import { logger } from '../config/logger.js';

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
 * How long a session survives *inactivity* before a fresh login is required.
 *
 * Tokens are minted for this full window and re-issued while the user is
 * active (see the auth middleware), so the window slides instead of counting
 * down from login. Configurable via SESSION_IDLE_DAYS; defaults to 30 days.
 */
const SESSION_IDLE_DAYS = (() => {
  const parsed = parseInt(process.env.SESSION_IDLE_DAYS || '30', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn({ value: process.env.SESSION_IDLE_DAYS }, 'Invalid SESSION_IDLE_DAYS, falling back to 30 days');
    return 30;
  }
  return parsed;
})();

const SESSION_IDLE_TTL_SECONDS = SESSION_IDLE_DAYS * 24 * 60 * 60;

/**
 * Re-issue the token once less than 80% of its life remains. Renewing on
 * every request would rewrite the cookie constantly for no benefit; waiting
 * until the last moment would leave no slack for clock skew.
 */
const TOKEN_RENEWAL_THRESHOLD_SECONDS = Math.floor(SESSION_IDLE_TTL_SECONDS * 0.8);

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
    maxAge: SESSION_IDLE_TTL_SECONDS * 1000,
  };
}

/**
 * Generate JWT authentication token for a user
 * @param {string} userId - User ID to encode in the token
 * @param {string} jwtSecret - JWT secret key
 * @param {Object} options - Additional options
 * @param {number} options.tokenVersion - User's current token version
 * @param {string} options.sessionId - Session ID to bind token to
 * @param {number|string} options.expiresIn - Token expiration (default: the idle window)
 * @returns {string} JWT token
 */
function generateAuthToken(userId, jwtSecret, options = {}) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('generateAuthToken: userId must be a non-empty string');
  }
  if (!jwtSecret || typeof jwtSecret !== 'string') {
    throw new Error('generateAuthToken: jwtSecret must be a non-empty string');
  }

  const { tokenVersion = 1, sessionId = null, expiresIn = SESSION_IDLE_TTL_SECONDS } = options;

  const payload = {
    id: userId,
    v: tokenVersion,
  };

  // Add session ID if provided (for individual session revocation)
  if (sessionId) {
    payload.sid = sessionId;
  }

  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign(payload, jwtSecret, { expiresIn, algorithm: 'HS256' });
}

export {
  getCookieOptions,
  generateAuthToken,
  SESSION_IDLE_DAYS,
  SESSION_IDLE_TTL_SECONDS,
  TOKEN_RENEWAL_THRESHOLD_SECONDS,
};
