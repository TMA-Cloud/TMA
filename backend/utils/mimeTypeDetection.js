const FileType = require('file-type');
const mime = require('mime-types');
const path = require('path');
const { logger } = require('../config/logger');

/**
 * Normalize MIME type for comparison (lowercase, remove parameters)
 */
function normalizeMime(mimeType) {
  if (!mimeType) return null;
  return mimeType.toLowerCase().split(';')[0].trim();
}

/**
 * Detects the actual MIME type from file content (magic bytes)
 * @param {string} filePath - Path to the file
 * @returns {Promise<string|null>} Detected MIME type or null if detection fails
 */
async function detectMimeTypeFromContent(filePath) {
  try {
    const fileType = await FileType.fromFile(filePath);
    return fileType ? fileType.mime : null;
  } catch (error) {
    logger.warn({ error: error.message, filePath }, 'Failed to detect MIME type from file content');
    return null;
  }
}

/**
 * Detects and returns the actual MIME type from file content
 * Uses actual MIME type instead of declared one to prevent spoofing
 * @param {string} filePath - Path to the uploaded file
 * @param {string} declaredMimeType - MIME type declared by client (fallback if detection fails)
 * @param {string} filename - Original filename
 * @returns {Promise<Object>} { valid: boolean, actualMimeType: string|null, error: string|null }
 */
async function validateMimeType(filePath, declaredMimeType, filename) {
  const actualMimeType = await detectMimeTypeFromContent(filePath);

  if (!actualMimeType) {
    logger.warn(
      { declaredMimeType, filename },
      'Could not detect MIME type from file content, using declared MIME type'
    );
    return { valid: true, actualMimeType: declaredMimeType, error: null };
  }

  const normalizedActual = normalizeMime(actualMimeType);
  const normalizedDeclared = normalizeMime(declaredMimeType);

  if (normalizedDeclared && normalizedActual !== normalizedDeclared) {
    logger.warn({ declaredMimeType, actualMimeType, filename }, '[SECURITY] MIME type mismatch detected');
  }

  return { valid: true, actualMimeType, error: null };
}

/**
 * Get expected MIME types for an extension using mime-types package
 * Some extensions may have multiple valid MIME types (e.g., CSV can be text/csv or text/plain)
 * @param {string} ext - File extension (without dot)
 * @returns {string[]} Array of expected MIME types
 */
function getExpectedMimeTypesForExtension(ext) {
  const expectedMimeTypes = [];

  // Get primary MIME type from mime-types package
  const primaryMime = mime.lookup(`.${ext}`);
  if (primaryMime) {
    expectedMimeTypes.push(primaryMime);
  }

  // Special cases: some extensions have multiple valid MIME types
  if (ext === 'csv') {
    // CSV files can be detected as text/plain by file-type, which is also valid
    if (!expectedMimeTypes.includes('text/plain')) {
      expectedMimeTypes.push('text/plain');
    }
    // Some systems use application/csv
    if (!expectedMimeTypes.includes('application/csv')) {
      expectedMimeTypes.push('application/csv');
    }
  }

  return expectedMimeTypes;
}

/**
 * Validates that a file's actual MIME type matches what ONLYOFFICE expects for the given extension
 * @param {string} filePath - Path to the file
 * @param {string} filename - Filename with extension
 * @param {string} storedMimeType - MIME type stored in database
 * @param {boolean} isEncrypted - Whether the file is encrypted (can't detect MIME from encrypted content)
 * @returns {Promise<Object>} { valid: boolean, error: string|null, actualMimeType: string|null }
 */
async function validateOnlyOfficeMimeType(filePath, filename, storedMimeType, isEncrypted = false) {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, '');

  const expectedMimeTypes = getExpectedMimeTypesForExtension(ext);
  if (expectedMimeTypes.length === 0) {
    return {
      valid: false,
      error: `File extension .${ext} is not recognized or not supported by ONLYOFFICE`,
      actualMimeType: null,
    };
  }

  const normalizedExpected = expectedMimeTypes.map(normalizeMime);
  const normalizedStored = normalizeMime(storedMimeType);

  // For encrypted files, we can't detect MIME type from content, so validate stored MIME type
  if (isEncrypted) {
    if (!storedMimeType) {
      return {
        valid: false,
        error: 'File MIME type not available. Cannot verify file type for encrypted file.',
        actualMimeType: null,
      };
    }

    // Check if stored MIME type matches expected type
    if (!normalizedExpected.includes(normalizedStored)) {
      logger.warn(
        {
          filename,
          extension: ext,
          storedMimeType,
          expectedMimeTypes,
        },
        '[ONLYOFFICE] Stored MIME type does not match expected type for extension'
      );
      return {
        valid: false,
        error: `Cannot open file: type mismatch (expected .${ext} format)`,
        actualMimeType: storedMimeType,
      };
    }

    // Stored MIME type matches expected - allow (we trust the stored type for encrypted files)
    return {
      valid: true,
      error: null,
      actualMimeType: storedMimeType,
    };
  }

  // For unencrypted files, detect actual MIME type from file content
  const actualMimeType = await detectMimeTypeFromContent(filePath);

  // If detection fails for unencrypted file, fall back to stored MIME type if it matches expected
  if (!actualMimeType) {
    if (storedMimeType && normalizedExpected.includes(normalizedStored)) {
      // Stored MIME type matches expected - allow (file-type might not detect all formats)
      logger.info(
        { filename, storedMimeType, extension: ext },
        '[ONLYOFFICE] MIME type detection failed, but stored MIME type matches expected type'
      );
      return {
        valid: true,
        error: null,
        actualMimeType: storedMimeType,
      };
    }

    // Detection failed and stored type doesn't match - reject for security
    logger.warn(
      { filename, storedMimeType, extension: ext },
      '[ONLYOFFICE] Could not detect MIME type from file content and stored type does not match expected'
    );
    return {
      valid: false,
      error: 'Unable to verify file type. File may be corrupted or invalid.',
      actualMimeType: null,
    };
  }

  const normalizedActual = normalizeMime(actualMimeType);

  // Check if actual MIME type matches any expected type
  const matchesExpected = normalizedExpected.includes(normalizedActual);

  if (!matchesExpected) {
    logger.warn(
      {
        filename,
        extension: ext,
        actualMimeType,
        expectedMimeTypes,
        storedMimeType,
      },
      '[ONLYOFFICE] MIME type mismatch - file content does not match expected type for extension'
    );
    return {
      valid: false,
      error: `Cannot open file: type mismatch (expected .${ext} format)`,
      actualMimeType,
    };
  }

  return {
    valid: true,
    error: null,
    actualMimeType,
  };
}

module.exports = {
  detectMimeTypeFromContent,
  validateMimeType,
  validateOnlyOfficeMimeType,
};
