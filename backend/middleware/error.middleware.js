import { logger } from '../config/logger.js';
import { sendError } from '../utils/response.js';

const errorHandler = (err, req, res, _next) => {
  // Request explicitly aborted by client (e.g. user clicked "Cancel upload").
  // Treat this as a cancelled request. The upload middleware cleans up bucket objects.
  if (err.message === 'Request aborted') {
    logger.info({ path: req.path, method: req.method }, 'Request aborted by client');
    return sendError(res, 499, 'Upload cancelled by client', null, { error: 'REQUEST_ABORTED' });
  }

  // Storage limit errors (from upload middleware)
  if (err.message && (err.message.includes('Storage limit exceeded') || err.message.includes('storage limit'))) {
    return sendError(res, 413, err.message, null, { error: 'STORAGE_LIMIT_EXCEEDED' });
  }

  // Database errors
  if (err.code === '23505') {
    // PostgreSQL unique violation
    return sendError(res, 409, 'Resource already exists', null, { error: 'DUPLICATE_RESOURCE' });
  }

  if (err.code === '23503') {
    // PostgreSQL foreign key violation
    return sendError(res, 400, 'Invalid reference', null, { error: 'INVALID_REFERENCE' });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return sendError(res, 401, 'Invalid token', null, { error: 'INVALID_TOKEN' });
  }

  if (err.name === 'TokenExpiredError') {
    return sendError(res, 401, 'Token expired', null, { error: 'TOKEN_EXPIRED' });
  }

  // File system errors (e.g. missing static/frontend file) - expected when frontend not built
  if (err.code === 'ENOENT') {
    logger.warn({ path: err.path }, 'File not found (e.g. frontend not built or missing static file)');
    return sendError(res, 404, 'File not found', null, { error: 'FILE_NOT_FOUND' });
  }

  if (err.code === 'EACCES') {
    return sendError(res, 403, 'Permission denied', null, { error: 'PERMISSION_DENIED' });
  }

  // Default error - only truly unhandled errors reach here
  // Always return generic error code to client (production-like); full details remain in server logs
  sendError(res, err.status || 500, err.message || 'Internal server error', err, { error: 'INTERNAL_ERROR' });
};

export default errorHandler;
