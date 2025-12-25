const { getUserCustomDriveSettings } = require('../models/user.model');
const { logger } = require('../config/logger');

/**
 * Middleware to pre-fetch custom drive settings and attach to request
 * This allows multer's synchronous destination callback to access the path
 */
async function attachCustomDrivePath(req, res, next) {
  try {
    if (req.userId) {
      const customDrive = await getUserCustomDriveSettings(req.userId);
      if (customDrive.enabled && customDrive.path) {
        req.customDrivePath = customDrive.path;
      }
    }
  } catch (error) {
    // Log error but don't fail the request - will fall back to UPLOAD_DIR
    logger.warn({ userId: req.userId, error: error.message }, 'Failed to fetch custom drive settings for upload');
  }
  next();
}

module.exports = { attachCustomDrivePath };
