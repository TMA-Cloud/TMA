const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Extract and decode JWT token from request
 * @param {Object} req - Express request object
 * @returns {Object|null} Decoded token or null if not found/invalid
 */
function extractTokenFromRequest(req) {
  let token;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').map(c => c.trim());
    const t = cookies.find(c => c.startsWith('token='));
    if (t) token = t.slice('token='.length);
  }
  if (!token && req.headers.authorization) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

/**
 * Get session ID from request token
 * @param {Object} req - Express request object
 * @returns {string|null} Session ID or null
 */
function getSessionIdFromRequest(req) {
  const decoded = extractTokenFromRequest(req);
  return decoded?.sid || null;
}

module.exports = {
  extractTokenFromRequest,
  getSessionIdFromRequest,
};
