const path = require('path');

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

const CUSTOM_DRIVE_ENABLED = process.env.CUSTOM_DRIVE === 'yes';
const CUSTOM_DRIVE_PATH = process.env.CUSTOM_DRIVE_PATH
  ? path.resolve(process.env.CUSTOM_DRIVE_PATH)
  : null;

module.exports = { 
  UPLOAD_DIR,
  CUSTOM_DRIVE_ENABLED,
  CUSTOM_DRIVE_PATH,
};
