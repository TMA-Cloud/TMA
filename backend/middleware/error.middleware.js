import { logger } from '../config/logger.js';
import { safeUnlink } from '../utils/fileCleanup.js';
import { sendError } from '../utils/response.js';

const errorHandler = (err, req, res, _next) => {
  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 400, 'File too large', null, { error: 'FILE_TOO_LARGE' });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return sendError(res, 400, 'Unexpected file field', null, { error: 'UNEXPECTED_FILE' });
  }

  // Request explicitly aborted by client (e.g. user clicked "Cancel upload").
  // Treat this as a cancelled request, not a server error, and best-effort
  // cleanup any temp files that may have been written by multer.
  if (err.message === 'Request aborted') {
    (async () => {
      try {
        if (Array.isArray(req.files)) {
          for (const file of req.files) {
            if (file?.path) {
              await safeUnlink(file.path);
            }
          }
        } else if (req.files && typeof req.files === 'object') {
          // Multer can also expose files as an object of arrays keyed by fieldname
          for (const value of Object.values(req.files)) {
            const arr = Array.isArray(value) ? value : [value];
            for (const file of arr) {
              if (file?.path) {
                await safeUnlink(file.path);
              }
            }
          }
        }
        if (req.file?.path) {
          await safeUnlink(req.file.path);
        }
      } catch {
        // Ignore cleanup errors; they're non-fatal in this context.
      }
    })();

    logger.info({ path: req.path, method: req.method }, 'Request aborted by client');
    return sendError(res, 499, 'Upload cancelled by client', null, { error: 'REQUEST_ABORTED' });
  }

  // Storage limit errors (from our middleware or fileFilter)
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
