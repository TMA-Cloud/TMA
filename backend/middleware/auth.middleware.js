const jwt = require('jsonwebtoken');
const { setUserId } = require('./requestId.middleware');
const { logger } = require('../config/logger');
const { getUserTokenVersion } = require('../models/user.model');
const { validateClientFingerprint, SESSION_BINDING_ENABLED } = require('../utils/auth');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

module.exports = async function(req, res, next) {
  let token;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').map(c => c.trim());
    const t = cookies.find(c => c.startsWith('token='));
    if (t) token = t.slice('token='.length);
  }
  if (!token && req.headers.authorization) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    // Explicitly specify allowed algorithms to prevent algorithm confusion attacks
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.userId = decoded.id;

    // Verify token version - protects against stolen tokens after "logout all devices"
    const currentTokenVersion = await getUserTokenVersion(decoded.id);
    if (currentTokenVersion === null) {
      logger.warn({ userId: decoded.id }, 'Token validation failed: user not found');
      return res.status(401).json({ message: 'Invalid token' });
    }
    
    // Check if token version matches (token.v might be undefined for old tokens)
    const tokenVersion = decoded.v || 1;
    if (tokenVersion !== currentTokenVersion) {
      logger.warn({ userId: decoded.id, tokenVersion, currentTokenVersion }, 'Token validation failed: session invalidated');
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    // Validate client fingerprint to detect token theft
    if (SESSION_BINDING_ENABLED && decoded.fp) {
      if (!validateClientFingerprint(decoded.fp, req)) {
        logger.warn({ userId: decoded.id }, 'Token validation failed: fingerprint mismatch (possible token theft)');
        // Log this as a security event
        const { logAuditEvent } = require('../services/auditLogger');
        await logAuditEvent('auth.suspicious_token', {
          status: 'failure',
          resourceType: 'auth',
          details: 'Token fingerprint mismatch - possible session hijacking attempt'
        }, req);
        return res.status(401).json({ message: 'Session invalid. Please login again.' });
      }
    }

    // Store userId in CLS context for automatic propagation to logs and audit events
    setUserId(decoded.id);

    next();
  } catch (err) {
    logger.warn({ err }, 'Invalid token provided');
    return res.status(401).json({ message: 'Invalid token' });
  }
};
