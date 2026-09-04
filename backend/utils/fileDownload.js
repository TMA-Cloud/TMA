import path from 'path';

import { logger } from '../config/logger.js';
import { resolveIkmForPath } from '../models/file/file.dek.model.js';
import { isFilePathEncrypted, isValidPath } from './filePath.js';
import {
  ciphertextSizeToPlaintextSize,
  createDecryptStreamFromStream,
  createRangeDecryptStream,
} from './fileEncryption.js';
import storage from './storageDriver.js';

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
 * Parse a single HTTP Range header against a known content size.
 * Multi-range and malformed headers are ignored (serve the full body instead).
 * @param {string|undefined} rangeHeader
 * @param {number} size - Total content (plaintext) size in bytes
 * @returns {{ start: number, end: number } | { unsatisfiable: true } | null}
 */
function parseRange(rangeHeader, size) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return null;

  let start;
  let end;
  if (startStr === '') {
    // Suffix range: the final N bytes.
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    if (end > size - 1) end = size - 1;
    if (size === 0 || start > end || start >= size) return { unsatisfiable: true };
  }
  return { start, end };
}

/**
 * Validates and resolves a file for download. Returns the storage key (which is
 * the DB path for both local and S3) and the encrypted object's size.
 * @param {Object} file - File object from database
 * @returns {Promise<{ success: boolean, storageKey?: string, ciphertextSize?: number, isEncrypted?: boolean, error?: string }>}
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

  let stat;
  try {
    stat = await storage.statObject(file.path);
  } catch (err) {
    logger.warn({ err, key: file.path }, 'Error checking stored object');
    return { success: false, error: 'Error accessing file storage' };
  }
  if (!stat) {
    return { success: false, error: 'File not found in storage' };
  }

  return {
    success: true,
    storageKey: file.path,
    ciphertextSize: stat.size,
    isEncrypted: isFilePathEncrypted(file.path),
  };
}

/**
 * Stream an encrypted (streaming-AEAD) object to the response, honouring HTTP
 * Range requests. A ranged request only fetches and decrypts the overlapping
 * segments, so large files can be opened/seeked without a full download.
 *
 * @param {Object} res - Express response
 * @param {string} storageKey - Storage key of the encrypted object
 * @param {string} filename - Original filename for Content-Disposition
 * @param {string} mimeType - Content-Type
 * @param {Object} [options]
 * @param {import('express').Request} [options.req] - Request (read for its Range header)
 * @param {number} [options.ciphertextSize] - Encrypted object size, if already known
 * @param {'attachment'|'inline'} [options.disposition] - Content-Disposition type (default 'attachment')
 * @param {Buffer} [options.ikm] - Streaming key; resolved from the object's wrapped DEK when omitted
 */
async function streamEncryptedFile(res, storageKey, filename, mimeType, options = {}) {
  const { req, disposition = 'attachment' } = options;
  let cleanupCalled = false;
  let active = null;

  const cleanup = () => {
    if (!cleanupCalled) {
      cleanupCalled = true;
      if (active && active.cleanup) active.cleanup();
    }
  };

  const errorDetails = error => ({
    message: error?.message || 'Unknown error',
    code: error?.code,
    stack: error?.stack,
    storageKey,
  });

  try {
    let ciphertextSize = options.ciphertextSize;
    if (ciphertextSize == null) {
      const stat = await storage.statObject(storageKey);
      if (!stat) {
        return res.status(404).json({ error: 'File not found' });
      }
      ciphertextSize = stat.size;
    }
    const plaintextSize = ciphertextSizeToPlaintextSize(ciphertextSize);

    res.type(mimeType);
    res.setHeader('Content-Disposition', contentDispositionValue(disposition, filename));
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req ? parseRange(req.headers?.range, plaintextSize) : null;

    if (range && range.unsatisfiable) {
      res.setHeader('Content-Range', `bytes */${plaintextSize}`);
      return res.status(416).end();
    }

    // Envelope files decrypt under their own wrapped DEK; pre-envelope files
    // resolve to the master key. Callers may pass a pre-resolved ikm.
    const ikm = options.ikm ?? (await resolveIkmForPath(storageKey));

    let decryptResult;
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${plaintextSize}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      decryptResult = await createRangeDecryptStream({
        readRange: (start, end) => storage.getReadStream(storageKey, { start, end }),
        plaintextSize,
        start: range.start,
        end: range.end,
        ikm,
      });
    } else {
      res.setHeader('Content-Length', String(plaintextSize));
      decryptResult = await createDecryptStreamFromStream(await storage.getReadStream(storageKey), ikm);
    }

    active = decryptResult;
    const decryptStream = decryptResult.stream;

    decryptStream.on('error', error => {
      logger.error(errorDetails(error), 'Error streaming decrypted file');
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
        logger.warn({ error: error.message, code: error.code, storageKey }, 'Response error during decryption stream');
      }
      cleanup();
    });

    res.on('close', cleanup);

    decryptStream.pipe(res);
  } catch (error) {
    logger.error(errorDetails(error), 'Error creating decrypt stream');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error decrypting file' });
    }
    cleanup();
  }
}

/**
 * Stream a non-encrypted object to the response (legacy/unencrypted objects).
 * @param {Object} res - Express response
 * @param {string} storageKey - Storage key
 * @param {string} filename - Original filename for Content-Disposition
 * @param {string} mimeType - Content-Type
 * @param {boolean} attachment - If true, "attachment" disposition, else "inline"
 */
async function streamUnencryptedFile(res, storageKey, filename, mimeType, attachment = false) {
  res.type(mimeType);
  const disposition = attachment ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', contentDispositionValue(disposition, filename));

  const stream = await storage.getReadStream(storageKey);

  stream.on('error', error => {
    logger.error({ error, storageKey }, 'Error streaming file');
    if (!res.headersSent) {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.destroy();
    }
  });

  res.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });

  stream.pipe(res);
}

export { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile, contentDispositionValue, parseRange };
