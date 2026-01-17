const fs = require('fs');
const path = require('path');
const { resolveFilePath, isValidPath, isFilePathEncrypted } = require('./filePath');
const { createDecryptStream } = require('./fileEncryption');
const { logger } = require('../config/logger');
const { isAgentOfflineError } = require('./agentErrorDetection');

/**
 * Validates and resolves file path for download
 * @param {Object} file - File object from database
 * @returns {Promise<Object>} { success: boolean, filePath?: string, isEncrypted?: boolean, error?: string }
 */
async function validateAndResolveFile(file) {
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

  // For custom drive files (absolute paths), verify via agent
  if (path.isAbsolute(file.path)) {
    try {
      const { agentStatPath } = require('./agentFileOperations');
      await agentStatPath(filePath); // Verify file exists via agent
      // Path is valid - use it as-is (agent will handle case sensitivity)
    } catch (err) {
      // Check if error is agent connection related
      if (isAgentOfflineError(err)) {
        return {
          success: false,
          error: 'Agent is offline. Please refresh agent connection in Settings.',
          agentOffline: true,
        };
      }
      // File doesn't exist or other error
      return { success: false, error: 'File not found via agent' };
    }
  } else {
    // Regular file - check filesystem
    filePath = path.resolve(filePath);
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found on disk' };
    }
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

/**
 * Stream an unencrypted file to response
 * For custom drive files (absolute paths), uses agent API
 * @param {Object} res - Express response object
 * @param {string} filePath - Path to file
 * @param {string} filename - Original filename for Content-Disposition header
 * @param {string} mimeType - MIME type for Content-Type header
 * @param {boolean} attachment - If true, use "attachment" disposition (download), else "inline" (view)
 */
async function streamUnencryptedFile(res, filePath, filename, mimeType, attachment = false) {
  res.type(mimeType);
  const encodedFilename = encodeURIComponent(filename);
  const disposition = attachment ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`);

  // If it's a custom drive path (absolute), use agent API with streaming
  if (path.isAbsolute(filePath)) {
    try {
      const { agentReadFileStream } = require('./agentFileOperations');
      const stream = agentReadFileStream(filePath);

      // Handle stream errors
      stream.on('error', error => {
        logger.error({ error, filePath }, 'Error streaming file via agent');
        if (!res.headersSent) {
          res.status(404).json({ error: 'File not found' });
        } else {
          res.destroy();
        }
      });

      // Handle client disconnect
      res.on('close', () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });

      // Pipe stream directly to response (memory efficient for large files)
      stream.pipe(res);
    } catch (error) {
      logger.error({ error, filePath }, 'Error creating stream via agent');
      if (!res.headersSent) {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.destroy();
      }
    }
    return;
  }

  // Regular file - use direct filesystem access
  const stream = fs.createReadStream(filePath);

  stream.on('error', error => {
    logger.error({ error, filePath }, 'Error streaming file');
    if (!res.headersSent) {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.destroy();
    }
  });

  res.on('close', () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  });

  stream.pipe(res);
}

module.exports = {
  validateAndResolveFile,
  streamEncryptedFile,
  streamUnencryptedFile,
};
