const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');

/**
 * Resolves a file path from the database to an absolute file system path
 * Handles both relative paths (regular uploaded files) and absolute paths (custom drive files)
 * @param {string} dbPath - Path stored in database (can be relative or absolute)
 * @returns {string} Absolute file system path
 */
function resolveFilePath(dbPath) {
  if (!dbPath) {
    throw new Error('File path is required');
  }

  // If path is already absolute (custom drive files), use it directly
  if (path.isAbsolute(dbPath)) {
    return path.resolve(dbPath);
  }

  // For relative paths (regular uploaded files), join with UPLOAD_DIR
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

  // Absolute paths (custom drive) are allowed
  if (path.isAbsolute(dbPath)) {
    return true;
  }

  // Relative paths should not contain path traversal sequences
  return !dbPath.includes('..') && !dbPath.includes('/') && !dbPath.includes('\\');
}

module.exports = {
  resolveFilePath,
  isValidPath,
};
