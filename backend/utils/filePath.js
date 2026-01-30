const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');

/**
 * Resolves a file path from the database to an absolute file system path.
 * Paths are relative to UPLOAD_DIR.
 * @param {string} dbPath - Path stored in database (relative)
 * @returns {string} Absolute file system path
 */
function resolveFilePath(dbPath) {
  if (!dbPath) {
    throw new Error('File path is required');
  }

  // For all paths, join with UPLOAD_DIR
  const filePath = path.join(UPLOAD_DIR, dbPath);

  // Ensure the resolved path is within uploads directory (security check)
  const resolvedUploadDir = path.resolve(UPLOAD_DIR);
  const resolvedFilePath = path.resolve(filePath);

  if (!resolvedFilePath.startsWith(resolvedUploadDir)) {
    throw new Error('Invalid file path: path traversal detected');
  }

  return resolvedFilePath;
}

/**
 * Validates a file path to prevent path traversal attacks
 * @param {string} dbPath - Path stored in database
 * @returns {boolean} True if path is valid
 */
function isValidPath(dbPath) {
  if (!dbPath) return false;

  // Relative paths should not contain path traversal sequences
  return !dbPath.includes('..') && !dbPath.includes('/') && !dbPath.includes('\\');
}

/**
 * Determines if a file path indicates the file is encrypted.
 * All stored files are encrypted.
 * @param {string} dbPath - Path stored in database
 * @returns {boolean} True if file is encrypted
 */
function isFilePathEncrypted(dbPath) {
  if (!dbPath) return false;
  return true;
}

module.exports = {
  resolveFilePath,
  isValidPath,
  isFilePathEncrypted,
};
