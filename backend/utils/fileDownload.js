const fs = require('fs');
const { resolveFilePath, isValidPath, isFilePathEncrypted } = require('./filePath');
const { createDecryptStream } = require('./fileEncryption');
const { logger } = require('../config/logger');

/**
 * Validates and resolves file path for download
 * @param {Object} file - File object from database
 * @returns {Object} { success: boolean, filePath?: string, isEncrypted?: boolean, error?: string }
 */
function validateAndResolveFile(file) {
  if (!file) {
    return { success: false, error: 'File not found' };
  }

  if (!file.path) {
    return { success: false, error: 'File path not found' };
  }

  if (!isValidPath(file.path)) {
    return { success: false, error: 'Invalid file path' };
  }

  let filePath;
  try {
    filePath = resolveFilePath(file.path);
  } catch (err) {
    return { success: false, error: err.message || 'Invalid file path' };
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'File not found on disk' };
  }

  // Check if file is encrypted based on path type
  const isEncrypted = isFilePathEncrypted(file.path);

  return { success: true, filePath, isEncrypted };
}

/**
 * Stream an encrypted file to response
 * @param {Object} res - Express response object
 * @param {string} encryptedPath - Path to encrypted file
 * @param {string} filename - Original filename for Content-Disposition header
 * @param {string} mimeType - MIME type for Content-Type header
 */
async function streamEncryptedFile(res, encryptedPath, filename, mimeType) {
  let cleanupCalled = false;
  let stream = null;

  const cleanup = () => {
    if (!cleanupCalled) {
      cleanupCalled = true;
      if (stream && stream.cleanup) {
        stream.cleanup();
      }
    }
  };

  // Helper to create error details object
  const createErrorDetails = error => ({
    message: error?.message || 'Unknown error',
    code: error?.code,
    stack: error?.stack,
    encryptedPath,
  });

  try {
    res.type(mimeType);
    const encodedFilename = encodeURIComponent(filename);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`);

    const decryptResult = await createDecryptStream(encryptedPath);
    stream = decryptResult;
    const decryptStream = decryptResult.stream;

    // Handle stream errors with better error logging
    decryptStream.on('error', error => {
      logger.error(createErrorDetails(error), 'Error streaming decrypted file');

      if (!res.headersSent) {
        res.status(500).json({ error: 'Error decrypting file' });
      } else {
        // If headers are sent, we can't send JSON, just destroy the connection
        res.destroy();
      }
      cleanup();
    });

    // Handle response errors (client disconnect, etc.)
    res.on('error', error => {
      // Ignore expected errors (client disconnect)
      const isExpectedError =
        error.code === 'ECONNRESET' ||
        error.code === 'EPIPE' ||
        error.code === 'ECONNABORTED' ||
        error.message === 'aborted' ||
        error.message?.includes('aborted') ||
        error.message?.includes('socket hang up');

      if (!isExpectedError) {
        logger.warn(
          { error: error.message, code: error.code, encryptedPath },
          'Response error during decryption stream'
        );
      }
      cleanup();
    });

    // Handle client disconnect
    res.on('close', () => {
      cleanup();
    });

    // Pipe the decrypted stream to response
    decryptStream.pipe(res);
  } catch (error) {
    logger.error(createErrorDetails(error), 'Error creating decrypt stream');

    if (!res.headersSent) {
      res.status(500).json({ error: 'Error decrypting file' });
    }
    cleanup();
  }
}

module.exports = {
  validateAndResolveFile,
  streamEncryptedFile,
};
