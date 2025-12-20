const jwt = require('jsonwebtoken');
const { setUserId } = require('./requestId.middleware');
const { logger } = require('../config/logger');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

module.exports = function(req, res, next) {
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

    // Store userId in CLS context for automatic propagation to logs and audit events
    setUserId(decoded.id);

    next();
  } catch (err) {
    logger.warn({ err }, 'Invalid token provided');
    return res.status(401).json({ message: 'Invalid token' });
  }
};
