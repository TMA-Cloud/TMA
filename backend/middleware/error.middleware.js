import { logger } from '../config/logger.js';
import { safeUnlink } from '../utils/fileCleanup.js';

const errorHandler = (err, req, res, _next) => {
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
    return res.status(499).json({
      message: 'Upload cancelled by client',
      error: 'REQUEST_ABORTED',
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

  // File system errors (e.g. missing static/frontend file) - expected when frontend not built
  if (err.code === 'ENOENT') {
    logger.warn({ path: err.path }, 'File not found (e.g. frontend not built or missing static file)');
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

  // Default error - only truly unhandled errors reach here
  logger.error({ err }, 'Unhandled error');
  // Always return generic error code to client (production-like); full details remain in server logs
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    error: 'INTERNAL_ERROR',
  });
};

export default errorHandler;
