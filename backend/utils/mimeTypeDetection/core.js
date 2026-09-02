/**
 * Core MIME detection: sniff a file's actual type from its magic bytes (never
 * trusting the client-declared type), compare against the declared type, and a
 * passthrough Transform that sniffs a stream's leading bytes for the S3 upload
 * path. The OnlyOffice-specific extension validation lives in ./onlyoffice.js.
 */

import { Transform } from 'stream';

import { logger } from '../../config/logger.js';

/** Leading bytes buffered to sniff a stream's type; magic bytes live well within this. */
const MIME_SNIFF_BYTES = 4100;

/**
 * file-type v17+ is ESM-only; load it dynamically and cache for use in CommonJS.
 * @returns {Promise<{ fileTypeFromFile: Function, fileTypeFromBuffer: Function }>}
 */
let fileTypeModulePromise = null;
async function getFileTypeModule() {
  if (!fileTypeModulePromise) {
    fileTypeModulePromise = import('file-type');
  }
  return fileTypeModulePromise;
}

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
    const { fileTypeFromFile } = await getFileTypeModule();
    const fileType = await fileTypeFromFile(filePath);
    return fileType ? fileType.mime : null;
  } catch (error) {
    logger.warn({ error: error.message, filePath }, 'Failed to detect MIME type from file content');
    return null;
  }
}

/**
 * Return the content-detected MIME type (not the client-declared one, which can
 * be spoofed), falling back to the declared type when detection fails.
 * @param {string} filePath - Path to the uploaded file
 * @param {string} declaredMimeType - Client-declared type (fallback)
 * @param {string} filename - Original filename
 * @returns {Promise<Object>} { valid, actualMimeType, error }
 */
async function validateMimeType(
  filePath,
  declaredMimeType,
  filename,
  { suppressFallbackWarning = false, onFallback = null, suppressMismatchWarning = false, onMismatch = null } = {}
) {
  const actualMimeType = await detectMimeTypeFromContent(filePath);

  if (!actualMimeType) {
    if (typeof onFallback === 'function') {
      onFallback({ declaredMimeType, filename });
    }
    if (!suppressFallbackWarning) {
      logger.warn(
        { declaredMimeType, filename },
        'Could not detect MIME type from file content, using declared MIME type'
      );
    }
    return { valid: true, actualMimeType: declaredMimeType, error: null, usedDeclaredFallback: true };
  }

  const normalizedActual = normalizeMime(actualMimeType);
  const normalizedDeclared = normalizeMime(declaredMimeType);

  // A generic declared type (application/octet-stream) counts as "unknown".
  if (
    normalizedDeclared &&
    normalizedDeclared !== 'application/octet-stream' &&
    normalizedActual !== normalizedDeclared
  ) {
    if (typeof onMismatch === 'function') {
      onMismatch({ declaredMimeType, actualMimeType, filename });
    }
    if (!suppressMismatchWarning) {
      logger.warn({ declaredMimeType, actualMimeType, filename }, '[SECURITY] MIME type mismatch detected');
    }
  }

  return { valid: true, actualMimeType, error: null, usedDeclaredFallback: false };
}

/**
 * Passthrough Transform that sniffs the MIME type from a stream's leading bytes
 * (the S3 upload path's equivalent of validateMimeType), so the stored type
 * comes from content, not the spoofable declared type or filename. The detected
 * type (or null) is handed to onDetect; detection never blocks or alters bytes.
 * @param {(mime: string|null) => void} onDetect
 * @returns {Transform}
 */
function createMimeSniffStream(onDetect) {
  const chunks = [];
  let length = 0;
  let sniffed = false;

  const sniff = async buffer => {
    sniffed = true;
    let detected = null;
    if (buffer && buffer.length >= 256) {
      try {
        const { fileTypeFromBuffer } = await getFileTypeModule();
        const fileType = await fileTypeFromBuffer(buffer);
        detected = fileType?.mime || null;
      } catch (err) {
        logger.debug({ err: err.message }, 'MIME sniff during upload failed; keeping the declared type');
      }
    }
    onDetect(detected);
  };

  return new Transform({
    async transform(chunk, encoding, callback) {
      if (sniffed) {
        this.push(chunk);
        return callback();
      }
      chunks.push(chunk);
      length += chunk.length;
      if (length < MIME_SNIFF_BYTES) {
        return callback();
      }
      const buffer = Buffer.concat(chunks);
      chunks.length = 0;
      await sniff(buffer);
      this.push(buffer);
      callback();
    },
    async flush(callback) {
      if (!sniffed) {
        const buffer = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
        await sniff(buffer);
        if (buffer.length > 0) this.push(buffer);
      }
      callback();
    },
  });
}

export { getFileTypeModule, normalizeMime, detectMimeTypeFromContent, validateMimeType, createMimeSniffStream };
