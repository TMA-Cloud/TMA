const { logger } = require('../config/logger');

const errorHandler = (err, req, res, _next) => {
  logger.error({ err }, 'Unhandled error');

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      message: 'File too large',
      error: 'FILE_TOO_LARGE',
    });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      message: 'Unexpected file field',
      error: 'UNEXPECTED_FILE',
    });
  }

  // Storage limit errors (from our middleware or fileFilter)
  if (err.message && (err.message.includes('Storage limit exceeded') || err.message.includes('storage limit'))) {
    return res.status(413).json({
      message: err.message,
      error: 'STORAGE_LIMIT_EXCEEDED',
    });
  }

  // Database errors
  if (err.code === '23505') {
    // PostgreSQL unique violation
    return res.status(409).json({
      message: 'Resource already exists',
      error: 'DUPLICATE_RESOURCE',
    });
  }

  if (err.code === '23503') {
    // PostgreSQL foreign key violation
    return res.status(400).json({
      message: 'Invalid reference',
      error: 'INVALID_REFERENCE',
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'INVALID_TOKEN',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      message: 'Token expired',
      error: 'TOKEN_EXPIRED',
    });
  }

  // File system errors
  if (err.code === 'ENOENT') {
    return res.status(404).json({
      message: 'File not found',
      error: 'FILE_NOT_FOUND',
    });
  }

  if (err.code === 'EACCES') {
    return res.status(403).json({
      message: 'Permission denied',
      error: 'PERMISSION_DENIED',
    });
  }

  // Default error
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    error: process.env.NODE_ENV === 'production' ? 'INTERNAL_ERROR' : err.stack,
  });
};

module.exports = errorHandler;
