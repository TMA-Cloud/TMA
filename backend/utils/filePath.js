const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');
const { useS3 } = require('./storageDriver');
const localStorage = require('./localStorage');

/**
 * Resolves a file path from the database to an absolute file system path (local only).
 * For S3, the DB path is the object key; use storage driver (getReadStream, etc.) instead.
 * @param {string} dbPath - Path stored in database (relative path or S3 key)
 * @returns {string} Absolute file system path (local only)
 */
function resolveFilePath(dbPath) {
  if (!dbPath) {
    throw new Error('File path is required');
  }
  if (useS3()) {
    throw new Error('resolveFilePath is for local storage only; use storage driver for S3');
  }

  const filePath = path.join(UPLOAD_DIR, dbPath);
  const resolvedUploadDir = path.resolve(UPLOAD_DIR);
  const resolvedFilePath = path.resolve(filePath);

  if (!resolvedFilePath.startsWith(resolvedUploadDir)) {
    throw new Error('Invalid file path: path traversal detected');
  }

  return resolvedFilePath;
}

/**
 * Resolve DB path to absolute path when using local storage; when S3, returns null.
 * @param {string} dbPath - Path stored in database
 * @returns {string|null} Absolute path or null if S3
 */
function resolveFilePathIfLocal(dbPath) {
  if (!dbPath) return null;
  if (useS3()) return null;
  return localStorage.resolveKey(dbPath);
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
  resolveFilePathIfLocal,
  isValidPath,
  isFilePathEncrypted,
};
