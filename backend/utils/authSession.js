/**
 * Authentication session utility functions
 * Extracted common patterns for session creation and token generation
 */

import { logger } from '../config/logger.js';
import { createSession } from '../models/session.model.js';
import { getUserTokenVersion } from '../models/user.model.js';
import { generateAuthToken, getCookieOptions } from './auth.js';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

/**
 * Extract IP address and user agent from request
 * @param {Object} req - Express request object
 * @returns {Object} Object with ipAddress and userAgent
 */
function extractRequestInfo(req) {
  return {
    ipAddress: req?.ip || req?.socket?.remoteAddress || null,
    userAgent: req?.headers?.['user-agent'] || null,
  };
}

/**
 * Create session and generate authentication token for a user
 * @param {string} userId - User ID
 * @param {Object} req - Express request object
 * @param {number} tokenVersion - Optional token version (if not provided, will fetch from DB)
 * @returns {Promise<Object>} Object with session and token
 */
async function createSessionAndToken(userId, req, tokenVersion = null) {
  // Get token version if not provided
  const finalTokenVersion = tokenVersion !== null ? tokenVersion : (await getUserTokenVersion(userId)) || 1;

  // Extract request info
  const { ipAddress, userAgent } = extractRequestInfo(req);

  // Create session
  const session = await createSession(userId, finalTokenVersion, userAgent, ipAddress);

  // Generate token
  const token = generateAuthToken(userId, JWT_SECRET, {
    tokenVersion: finalTokenVersion,
    sessionId: session.id,
    req,
  });

  return { session, token };
}

/**
 * Set authentication cookie and return success response
 * @param {Object} res - Express response object
 * @param {string} token - JWT token
 * @param {*} data - Response data
 * @param {number} status - HTTP status code
 */
function setAuthCookieAndRespond(res, token, data, status = 200) {
  res.cookie('token', token, getCookieOptions());
  res.status(status).json(data);
}

export { extractRequestInfo, createSessionAndToken, setAuthCookieAndRespond };
