const fs = require('fs');
const path = require('path');
const { resolveFilePath, isValidPath, isFilePathEncrypted } = require('./filePath');
const { createDecryptStream, createDecryptStreamFromStream } = require('./fileEncryption');
const { logger } = require('../config/logger');
const storage = require('./storageDriver');

/**
 * Build a Content-Disposition header value that is safe for Node's setHeader (ASCII-only).
 * Uses RFC 5987 (filename*=UTF-8''...) for the real filename; legacy filename= is ASCII-only
 * so headers never contain invalid characters (fixes ERR_INVALID_CHAR for mojibake/emoji names).
 */
function contentDispositionValue(disposition, filename) {
  const name = typeof filename === 'string' ? filename : 'download';
  const ext = path.extname(name);
  const asciiSafe = name
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .trim();
  const legacyName = (asciiSafe && asciiSafe.length > 0 ? asciiSafe : 'download').replace(/^_+/, '') || 'download';
  const fallback = legacyName.endsWith(ext) ? legacyName : legacyName + (ext || '');
  let encoded;
  try {
    encoded = encodeURIComponent(name);
  } catch {
    encoded = encodeURIComponent(fallback);
  }
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Validates and resolves file for download (local path or S3 key).
 * @param {Object} file - File object from database
 * @returns {Promise<Object>} { success: boolean, filePath?: string, storageKey?: string, isEncrypted?: boolean, error?: string }
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

  const isEncrypted = isFilePathEncrypted(file.path);

  if (storage.useS3()) {
    const exists = await storage.exists(file.path);
    if (!exists) {
      return { success: false, error: 'File not found in storage' };
    }
    return { success: true, storageKey: file.path, isEncrypted };
  }

  let filePath;
  try {
    filePath = resolveFilePath(file.path);
  } catch (err) {
    return { success: false, error: err.message || 'Invalid file path' };
  }

  filePath = path.resolve(filePath);
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'File not found on disk' };
  }

  return { success: true, filePath, isEncrypted };
}

/**
 * Stream an encrypted file to response (local path or S3 key)
 * @param {Object} res - Express response object
 * @param {string} encryptedPathOrKey - Local path to encrypted file or S3 object key
 * @param {string} filename - Original filename for Content-Disposition header
 * @param {string} mimeType - MIME type for Content-Type header
 */
async function streamEncryptedFile(res, encryptedPathOrKey, filename, mimeType) {
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

  const createErrorDetails = error => ({
    message: error?.message || 'Unknown error',
    code: error?.code,
    stack: error?.stack,
    encryptedPathOrKey,
  });

  try {
    res.type(mimeType);
    res.setHeader('Content-Disposition', contentDispositionValue('attachment', filename));

    const decryptResult = storage.useS3()
      ? await createDecryptStreamFromStream(await storage.getReadStream(encryptedPathOrKey))
      : await createDecryptStream(encryptedPathOrKey);
    stream = decryptResult;
    const decryptStream = decryptResult.stream;

    decryptStream.on('error', error => {
      logger.error(createErrorDetails(error), 'Error streaming decrypted file');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error decrypting file' });
      } else {
        res.destroy();
      }
      cleanup();
    });

    res.on('error', error => {
      const isExpectedError =
        error.code === 'ECONNRESET' ||
        error.code === 'EPIPE' ||
        error.code === 'ECONNABORTED' ||
        error.message === 'aborted' ||
        error.message?.includes('aborted') ||
        error.message?.includes('socket hang up');
      if (!isExpectedError) {
        logger.warn(
          { error: error.message, code: error.code, encryptedPathOrKey },
          'Response error during decryption stream'
        );
      }
      cleanup();
    });

    res.on('close', () => {
      cleanup();
    });

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
 * Stream an unencrypted file to response (local path or S3 key)
 * @param {Object} res - Express response object
 * @param {string} filePathOrKey - Local file path or S3 object key
 * @param {string} filename - Original filename for Content-Disposition header
 * @param {string} mimeType - MIME type for Content-Type header
 * @param {boolean} attachment - If true, use "attachment" disposition (download), else "inline" (view)
 */
async function streamUnencryptedFile(res, filePathOrKey, filename, mimeType, attachment = false) {
  res.type(mimeType);
  const disposition = attachment ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', contentDispositionValue(disposition, filename));

  const stream = storage.useS3() ? await storage.getReadStream(filePathOrKey) : fs.createReadStream(filePathOrKey);

  stream.on('error', error => {
    logger.error({ error, filePathOrKey }, 'Error streaming file');
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
  contentDispositionValue,
};
