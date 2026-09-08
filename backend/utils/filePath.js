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

export { isValidPath, isFilePathEncrypted };
