const multer = require('multer');
const path = require('path');
const { UPLOAD_DIR, CUSTOM_DRIVE_ENABLED, CUSTOM_DRIVE_PATH } = require('../config/paths');

// Determine upload destination based on custom drive settings
// When custom drive is enabled, upload directly to custom drive path
// This avoids cross-filesystem move issues in Docker
const getUploadDestination = () => {
  if (CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH) {
    return CUSTOM_DRIVE_PATH;
  }
  return UPLOAD_DIR;
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, getUploadDestination());
  },
  filename: function (req, file, cb) {
    // Use temp filename - will be renamed to final name in createFile
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

module.exports = upload;
