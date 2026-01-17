const multer = require('multer');
const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');

// Always upload to UPLOAD_DIR temp location
// Files will be written to custom drive via agent API in createFile
// This ensures ALL custom drive operations go through agent
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Always use UPLOAD_DIR - files will be written to custom drive via agent
    cb(null, UPLOAD_DIR);
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
