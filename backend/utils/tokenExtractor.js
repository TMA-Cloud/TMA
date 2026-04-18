import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Extract and decode JWT token from request
 * @param {Object} req - Express request object
 * @returns {Object|null} Decoded token or null if not found/invalid
 */
/**
 * Extract the raw JWT string from a request's cookie or Authorization header.
 * Does not verify the token.
 * @param {Object} req - Express request object
 * @returns {string|null} Raw token or null if not present
 */
function extractRawToken(req) {
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').map(c => c.trim());
    const t = cookies.find(c => c.startsWith('token='));
    if (t) return t.slice('token='.length);
  }
  if (req.headers.authorization) {
    return req.headers.authorization.split(' ')[1] || null;
  }
  return null;
}

function extractTokenFromRequest(req) {
  const token = extractRawToken(req);
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

export { extractRawToken, extractTokenFromRequest, getSessionIdFromRequest };
