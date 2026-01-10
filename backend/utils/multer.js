const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { UPLOAD_DIR } = require('../config/paths');
const { logger } = require('../config/logger');

// Dynamic storage that uploads directly to custom drive if enabled
// Note: Custom drive path is pre-fetched by attachCustomDrivePath middleware
// and attached to req.customDrivePath before multer processes the file
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      // Check if custom drive path was pre-fetched by middleware
      if (req.customDrivePath) {
        const uploadDir = req.customDrivePath;
        try {
          // Verify directory exists - do NOT create it (paths must be pre-mounted volumes)
          // This matches the documentation: "paths must already exist as mounted volumes"
          if (!fs.existsSync(uploadDir)) {
            throw new Error(`Custom drive path does not exist: ${uploadDir}. Paths must be pre-mounted volumes.`);
          }
          // Verify it's actually a directory
          const stats = fs.statSync(uploadDir);
          if (!stats.isDirectory()) {
            throw new Error(`Custom drive path is not a directory: ${uploadDir}`);
          }
          cb(null, uploadDir);
          return;
        } catch (error) {
          // If custom drive path fails, log error and fall back to UPLOAD_DIR
          logger.warn(
            { userId: req.userId, path: uploadDir, error: error.message },
            'Custom drive path validation failed, falling back to UPLOAD_DIR'
          );
        }
      }
      // Default: upload to UPLOAD_DIR
      cb(null, UPLOAD_DIR);
    } catch (error) {
      // On error, fall back to UPLOAD_DIR
      logger.error({ error: error.message }, 'Error determining upload destination');
      cb(null, UPLOAD_DIR);
    }
  },
  filename: function (req, file, cb) {
    // Use temp filename - will be renamed to final name in createFile
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

/**
 * FileFilter - simplified since middleware already handles storage limit checks
 * This is kept as a safety net but middleware should catch issues first
 */
function fileFilter(req, file, cb) {
  // If response was already sent by middleware (storage limit exceeded), reject
  if (req.res && (req.res.headersSent || req.res.finished)) {
    return cb(new Error('Upload rejected - storage limit exceeded'), false);
  }
  // Allow file through - middleware and controller will handle validation
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB max file size (safety limit)
  },
});

module.exports = upload;
