/**
 * Input validation utilities to prevent injection attacks and validate user input
 */

/**
 * Validates and sanitizes a string input
 * @param {string} input - Input string
 * @param {number} maxLength - Maximum allowed length
 * @returns {string|null} Sanitized string or null if invalid
 */
function validateString(input, maxLength = 1000) {
  if (typeof input !== 'string') return null;
  if (input.length > maxLength) return null;
  // Remove null bytes and control characters (except newlines and tabs)
  return input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '').trim() || null;
}

/**
 * Validates an email address
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid email
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

/**
 * Validates a file/folder name
 * @param {string} name - Name to validate
 * @returns {boolean} True if valid name
 */
function validateFileName(name) {
  if (!name || typeof name !== 'string') return false;

  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return false;

  // Prevent path traversal attacks
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return false;

  // Prevent null bytes and control characters
  if (trimmed.includes('\x00') || /[\x00-\x1F\x7F]/.test(trimmed)) return false;

  // Prevent absolute paths (Unix and Windows)
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return false;

  // Prevent reserved characters on Windows/Linux
  const invalidChars = /[<>:"|?*]/;
  if (invalidChars.test(trimmed)) return false;

  // Prevent Windows reserved filenames
  const windowsReserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
  if (windowsReserved.test(trimmed)) return false;

  return true;
}

/**
 * Validates an array of IDs
 * @param {any} ids - IDs to validate
 * @param {number} maxLength - Maximum array length
 * @returns {string[]|null} Validated array or null if invalid
 */
function validateIdArray(ids, maxLength = 100) {
  if (!Array.isArray(ids)) return null;
  if (ids.length === 0 || ids.length > maxLength) return null;
  
  // Validate each ID is a string and matches expected format (16 char alphanumeric)
  const idRegex = /^[a-zA-Z0-9]{16}$/;
  const validIds = ids.filter(id => typeof id === 'string' && idRegex.test(id));
  
  return validIds.length === ids.length ? validIds : null;
}

/**
 * Validates a single ID
 * @param {any} id - ID to validate
 * @returns {string|null} Validated ID or null if invalid
 */
function validateId(id) {
  if (typeof id !== 'string') return null;
  const idRegex = /^[a-zA-Z0-9]{8,16}$/;
  return idRegex.test(id) ? id : null;
}

/**
 * Validates a sort field
 * @param {any} sortBy - Sort field to validate
 * @returns {string|null} Validated sort field or null if invalid
 */
function validateSortBy(sortBy) {
  const allowedFields = ['name', 'size', 'modified', 'deletedAt'];
  if (typeof sortBy !== 'string') return null;
  return allowedFields.includes(sortBy) ? sortBy : null;
}

/**
 * Validates sort order
 * @param {any} order - Sort order to validate
 * @returns {string|null} Validated order ('ASC' or 'DESC') or null if invalid
 */
function validateSortOrder(order) {
  if (typeof order !== 'string') return null;
  const upperOrder = order.toUpperCase();
  return (upperOrder === 'ASC' || upperOrder === 'DESC') ? upperOrder : null;
}

/**
 * Validates a search query
 * @param {any} query - Search query to validate
 * @param {number} maxLength - Maximum query length
 * @returns {string|null} Validated query or null if invalid
 */
function validateSearchQuery(query, maxLength = 200) {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  // Remove potentially dangerous characters but allow normal search terms
  return trimmed.replace(/[\x00-\x1F\x7F]/g, '') || null;
}

/**
 * Validates a limit parameter
 * @param {any} limit - Limit to validate
 * @param {number} maxLimit - Maximum allowed limit
 * @returns {number|null} Validated limit or null if invalid
 */
function validateLimit(limit, maxLimit = 1000) {
  const num = parseInt(limit, 10);
  if (isNaN(num) || num < 1 || num > maxLimit) return null;
  return num;
}

/**
 * Validates a boolean value
 * @param {any} value - Value to validate
 * @returns {boolean|null} Validated boolean or null if invalid
 */
function validateBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
}

/**
 * Validates a token (share link token)
 * @param {any} token - Token to validate
 * @returns {string|null} Validated token or null if invalid
 */
function validateToken(token) {
  if (typeof token !== 'string') return null;
  // Share tokens are 8 character alphanumeric
  const tokenRegex = /^[a-zA-Z0-9]{8}$/;
  return tokenRegex.test(token) ? token : null;
}

/**
 * Validates file upload for security concerns
 * For cloud storage, we allow all file types but ensure proper handling
 * @param {string} mimeType - MIME type to validate
 * @param {string} filename - Filename to validate extension
 * @returns {Object} { valid: boolean, error: string|null, requiresDownload: boolean }
 */
function validateFileUpload(mimeType, filename) {
  // Extract file extension
  const ext = filename ? filename.toLowerCase().match(/\.[^.]+$/) : null;
  const fileExtension = ext ? ext[0] : '';

  // List of executable file types that should be forced to download (not execute)
  const executableExtensions = [
    '.exe', '.dll', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jse',
    '.ws', '.wsf', '.wsh', '.ps1', '.psm1', '.msi', '.msp', '.jar', '.app', '.deb',
    '.rpm', '.dmg', '.pkg', '.sh', '.bash', '.csh', '.ksh', '.command', '.action',
    '.html', '.htm', '.svg' // Can contain scripts
  ];

  // Check for MIME type spoofing attempts (when extension doesn't match MIME)
  const mimeExtensionMap = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/gif': ['.gif'],
    'image/webp': ['.webp'],
    'image/svg+xml': ['.svg'],
    'application/pdf': ['.pdf'],
    'text/plain': ['.txt'],
    'text/html': ['.html', '.htm'],
    'application/zip': ['.zip'],
    'application/x-zip-compressed': ['.zip'],
    'application/json': ['.json'],
    'text/csv': ['.csv'],
  };

  // Warn about MIME type mismatches (potential spoofing)
  if (mimeType && mimeExtensionMap[mimeType.toLowerCase()]) {
    const expectedExtensions = mimeExtensionMap[mimeType.toLowerCase()];
    if (fileExtension && !expectedExtensions.includes(fileExtension)) {
      console.warn(`[SECURITY] Potential MIME spoofing: ${mimeType} with extension ${fileExtension}`);
    }
  }

  // Flag if file should be forced to download instead of inline display
  const requiresDownload = fileExtension && executableExtensions.includes(fileExtension);

  // All file types are allowed for cloud storage
  // Security is handled by:
  // 1. Not executing uploaded files
  // 2. Serving with proper Content-Disposition headers
  // 3. Storing outside of web-accessible directories
  // 4. Proper authentication/authorization
  return {
    valid: true,
    error: null,
    requiresDownload
  };
}

module.exports = {
  validateString,
  validateEmail,
  validateFileName,
  validateIdArray,
  validateId,
  validateSortBy,
  validateSortOrder,
  validateSearchQuery,
  validateLimit,
  validateBoolean,
  validateToken,
  validateFileUpload,
};

