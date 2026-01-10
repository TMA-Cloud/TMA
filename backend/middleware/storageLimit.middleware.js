const { getUserStorageUsage, getUserCustomDriveSettings, getUserStorageLimit } = require('../models/user.model');
const { checkStorageLimitExceeded } = require('../utils/storageUtils');
const { logger } = require('../config/logger');

/**
 * Middleware to check storage limits before file upload
 * This runs BEFORE multer processes the file, preventing unnecessary uploads
 */
async function checkStorageLimit(req, res, next) {
  try {
    // Get file size from Content-Length header
    const contentLength = parseInt(req.headers['content-length'], 10);

    // If no content length, let multer handle it (will fail if needed)
    if (!contentLength || isNaN(contentLength)) {
      return next();
    }

    const customDrive = await getUserCustomDriveSettings(req.userId);

    // For multipart/form-data, Content-Length includes boundaries and headers
    // Estimate actual file size by subtracting multipart overhead (~500 bytes)
    const estimatedFileSize = Math.max(0, contentLength - 500);

    const used = await getUserStorageUsage(req.userId);
    const basePath = process.env.UPLOAD_DIR || __dirname;
    const userStorageLimit = await getUserStorageLimit(req.userId);

    const checkResult = await checkStorageLimitExceeded({
      fileSize: estimatedFileSize,
      customDrive,
      used,
      userStorageLimit,
      defaultBasePath: basePath,
    });

    if (checkResult.exceeded) {
      res.status(413).json({
        message: checkResult.message,
        error: 'STORAGE_LIMIT_EXCEEDED',
      });
      return; // Don't call next() - this prevents multer from running
    }

    next();
  } catch (storageError) {
    logger.error({ err: storageError, userId: req.userId }, 'Error checking storage limit');
    // Block upload if we can't verify storage limit (fail-safe)
    res.status(500).json({
      message: 'Unable to verify storage limit. Please try again.',
      error: 'STORAGE_CHECK_FAILED',
    });
    // Don't call next() - this prevents multer from running
  }
}

module.exports = {
  checkStorageLimit,
};
