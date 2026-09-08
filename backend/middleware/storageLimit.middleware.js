import { logger } from '../config/logger.js';
import { getUserStorageLimit, getUserStorageUsage } from '../models/user.model.js';
import { checkStorageLimitExceeded } from '../utils/storageUtils.js';

/**
 * Middleware to check storage limits before file upload.
 * Runs before the upload stream is processed. Uses DB-based usage.
 */
async function checkStorageLimit(req, res, next) {
  try {
    // Get file size from Content-Length header
    const contentLength = parseInt(req.headers['content-length'], 10);

    // If no content length, let stream upload middleware handle it (will fail if needed)
    if (!contentLength || isNaN(contentLength)) {
      return next();
    }

    // For multipart/form-data, Content-Length includes boundaries and headers
    // Estimate actual file size by subtracting multipart overhead (~500 bytes)
    const estimatedFileSize = Math.max(0, contentLength - 500);

    const used = await getUserStorageUsage(req.ownerId);
    const userStorageLimit = await getUserStorageLimit(req.ownerId);

    const checkResult = await checkStorageLimitExceeded({
      fileSize: estimatedFileSize,
      used,
      userStorageLimit,
    });

    if (checkResult.exceeded) {
      res.status(413).json({
        message: checkResult.message,
        error: 'STORAGE_LIMIT_EXCEEDED',
      });
      return; // Don't call next() - this prevents stream upload middleware from running
    }

    next();
  } catch (storageError) {
    logger.error({ err: storageError, userId: req.userId, ownerId: req.ownerId }, 'Error checking storage limit');
    // Block upload if we can't verify storage limit (fail-safe)
    res.status(500).json({
      message: 'Unable to verify storage limit. Please try again.',
      error: 'STORAGE_CHECK_FAILED',
    });
    // Don't call next() - this prevents stream upload middleware from running
  }
}

export { checkStorageLimit };
