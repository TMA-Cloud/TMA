const multer = require('multer');
const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');
const { getMaxUploadSizeSettings } = require('../models/user.model');

/**
 * Disk storage engine - stores uploaded files in UPLOAD_DIR
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const filename = file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname);
    cb(null, filename);
  },
});

/**
 * Re-decode filename from Latin-1 to UTF-8. Busboy/multer default to Latin-1 for
 * Content-Disposition params, so UTF-8 filenames (emojis, non-English) become mojibake.
 */
function decodeFilenameToUtf8(name) {
  if (typeof name !== 'string' || !name) return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

/**
 * FileFilter - simplified since middleware already handles storage limit checks
 * This is kept as a safety net but middleware should catch issues first.
 * Also fixes filename encoding: multer/busboy treat filename as Latin-1 by default.
 */
function fileFilter(req, file, cb) {
  file.originalname = decodeFilenameToUtf8(file.originalname);
  // If response was already sent by middleware (storage limit exceeded), reject
  if (req.res && (req.res.headersSent || req.res.finished)) {
    return cb(new Error('Upload rejected - storage limit exceeded'), false);
  }
  // Allow file through - middleware and controller will handle validation
  cb(null, true);
}

/**
 * Create multer instance with configurable max file size from app settings.
 */
function createUploadWithLimit(limitBytes) {
  return multer({
    storage,
    fileFilter,
    limits: { fileSize: limitBytes },
  });
}

/**
 * Middleware: single file upload with max size from settings (admin-configurable).
 */
function uploadSingleWithDynamicLimit() {
  return (req, res, next) => {
    getMaxUploadSizeSettings()
      .then(settings => {
        const upload = createUploadWithLimit(settings.maxBytes);
        upload.single('file')(req, res, next);
      })
      .catch(err => next(err));
  };
}

/**
 * Middleware: multiple files upload with max size per file from settings (admin-configurable).
 */
function uploadArrayWithDynamicLimit() {
  return (req, res, next) => {
    getMaxUploadSizeSettings()
      .then(settings => {
        const upload = createUploadWithLimit(settings.maxBytes);
        upload.array('files')(req, res, next);
      })
      .catch(err => next(err));
  };
}

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // fallback if not using dynamic
});
module.exports.uploadSingleWithDynamicLimit = uploadSingleWithDynamicLimit;
module.exports.uploadArrayWithDynamicLimit = uploadArrayWithDynamicLimit;
