const { fileTypeFromFile, fileTypeFromBuffer } = require('file-type');
const mime = require('mime-types');
const mimeDb = require('mime-db');
const path = require('path');
const { Transform } = require('stream');
const { logger } = require('../config/logger');

const MIME_CHECK_BUFFER_SIZE = 8192;

/**
 * Reverse index: extension (lowercase) -> array of MIME types from mime-db.
 * Built once at load so we accept all MIME types that the official DB associates with an extension
 * (e.g. .exe -> application/x-msdos-program, application/x-msdownload, application/octet-stream).
 */
const extensionToMimeTypes = (function buildExtensionToMimes() {
  const map = Object.create(null);
  for (const [mimeType, data] of Object.entries(mimeDb)) {
    if (!data.extensions) continue;
    for (const ext of data.extensions) {
      const key = ext.toLowerCase();
      if (!map[key]) map[key] = [];
      if (!map[key].includes(mimeType)) map[key].push(mimeType);
    }
  }
  return map;
})();

/**
 * MIME types that file-type (magic-byte detection) or various clients may
 * return for an extension but that mime-db does not list for that extension.
 * Add them so validation still passes, especially for Microsoft Office formats.
 *
 * Keys are extensions WITHOUT the leading dot.
 */
const DETECTION_ALIASES = {
  msi: ['application/x-cfb'], // MSI is CFB/OLE; file-type reports application/x-cfb

  // CSV flexibility: file-type often sees CSVs as simple text
  csv: ['text/plain', 'application/csv', 'application/x-csv'],

  // --- Microsoft Word formats ---
  doc: [
    'application/msword',
    'application/x-msword',
    'application/vnd.ms-word',
    'application/vnd.ms-word.document.macroEnabled.12',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.ms-word.document.macroEnabled.12',
  ],
  docm: ['application/vnd.ms-word.document.macroEnabled.12'],
  dot: ['application/msword', 'application/x-msword'],
  dotx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.template'],
  dotm: ['application/vnd.ms-word.template.macroEnabled.12'],

  // Rich Text (opened by Word and other editors)
  rtf: ['application/rtf', 'text/rtf'],

  // --- Microsoft Excel formats ---
  xls: [
    'application/vnd.ms-excel',
    'application/msexcel',
    'application/x-msexcel',
    'application/x-ms-excel',
    'application/x-excel',
    'application/x-dos_ms_excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
  ],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
  xlsm: ['application/vnd.ms-excel.sheet.macroEnabled.12'],
  xlsb: ['application/vnd.ms-excel.sheet.binary.macroEnabled.12'],
  xltx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.template'],
  xltm: ['application/vnd.ms-excel.template.macroEnabled.12'],

  // --- Microsoft PowerPoint formats ---
  ppt: [
    'application/vnd.ms-powerpoint',
    'application/mspowerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  ],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'],
  pptm: ['application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
  pps: ['application/vnd.ms-powerpoint'],
  ppsx: ['application/vnd.openxmlformats-officedocument.presentationml.slideshow'],
  ppsm: ['application/vnd.ms-powerpoint.slideshow.macroEnabled.12'],
  potx: ['application/vnd.openxmlformats-officedocument.presentationml.template'],
  potm: ['application/vnd.ms-powerpoint.template.macroEnabled.12'],

  // --- OpenDocument formats (also commonly edited in Office) ---
  odt: ['application/vnd.oasis.opendocument.text'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet'],
  odp: ['application/vnd.oasis.opendocument.presentation'],

  // PDF (some clients send non-standard aliases)
  pdf: ['application/x-pdf', 'application/acrobat', 'application/vnd.pdf', 'text/pdf', 'text/x-pdf'],
};

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
    const fileType = await fileTypeFromFile(filePath);
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

  // If the client only sent a generic type (application/octet-stream),
  // treat it as "unknown" and don't log a mismatch warning.
  if (
    normalizedDeclared &&
    normalizedDeclared !== 'application/octet-stream' &&
    normalizedActual !== normalizedDeclared
  ) {
    logger.warn({ declaredMimeType, actualMimeType, filename }, '[SECURITY] MIME type mismatch detected');
  }

  return { valid: true, actualMimeType, error: null };
}

/**
 * Get expected MIME types for an extension using mime-db (all registered MIMEs for that extension)
 * plus mime-types primary and any content-detection aliases (e.g. file-type may return x-cfb for .msi).
 * @param {string} ext - File extension (without dot)
 * @returns {string[]} Array of expected MIME types
 */
function getExpectedMimeTypesForExtension(ext) {
  const key = ext.toLowerCase();
  const expected = extensionToMimeTypes[key] ? [...extensionToMimeTypes[key]] : [];

  const primary = mime.lookup(`.${key}`);
  if (primary && !expected.includes(primary)) {
    expected.unshift(primary);
  }

  const aliases = DETECTION_ALIASES[key];
  if (aliases) {
    for (const mimeType of aliases) {
      if (!expected.includes(mimeType)) expected.push(mimeType);
    }
  }

  return expected;
}

/**
 * Validate MIME type from a buffer (magic bytes) against the file extension.
 * Used for S3 stream upload to prevent spoofing (e.g. .exe renamed to .jpg).
 * @param {Buffer} buffer - First bytes of the file (at least 4KB recommended)
 * @param {string} filename - Original filename with extension
 * @returns {Promise<{ valid: boolean, error: string|null }>}
 */
async function validateMimeTypeFromBuffer(buffer, filename) {
  if (!buffer || buffer.length < 256) {
    return { valid: true, error: null };
  }
  if (typeof fileTypeFromBuffer !== 'function') {
    return { valid: true, error: null };
  }
  try {
    const fileType = await fileTypeFromBuffer(buffer);
    if (!fileType || !fileType.mime) {
      return { valid: true, error: null };
    }
    const ext = path.extname(filename).toLowerCase().replace(/^\./, '');
    const expected = getExpectedMimeTypesForExtension(ext);
    if (expected.length === 0) {
      return { valid: true, error: null };
    }
    const normalizedExpected = expected.map(normalizeMime);
    const normalizedActual = normalizeMime(fileType.mime);
    if (!normalizedExpected.includes(normalizedActual)) {
      logger.warn(
        { filename, detected: fileType.mime, expected },
        '[SECURITY] MIME spoof: content does not match extension'
      );
      return { valid: false, error: `File content does not match extension .${ext}` };
    }
    return { valid: true, error: null };
  } catch (err) {
    logger.warn({ err: err.message, filename }, 'MIME detection from buffer failed');
    return { valid: true, error: null };
  }
}

/**
 * Transform stream that buffers the first N bytes, validates MIME from magic bytes, then passes through.
 * Use in S3 stream upload pipeline to prevent MIME spoofing without writing to disk.
 * @param {string} filename - Original filename (for extension check)
 * @returns {Transform}
 */
function createMimeCheckStream(filename) {
  const chunks = [];
  let length = 0;
  let validated = false;

  return new Transform({
    async transform(chunk, encoding, callback) {
      if (validated) {
        this.push(chunk);
        return callback();
      }
      chunks.push(chunk);
      length += chunk.length;
      if (length < MIME_CHECK_BUFFER_SIZE) {
        return callback();
      }
      validated = true;
      const buffer = Buffer.concat(chunks);
      try {
        const result = await validateMimeTypeFromBuffer(buffer, filename);
        if (!result.valid) {
          this.destroy(new Error(result.error));
          return callback();
        }
        this.push(buffer);
        callback();
      } catch (err) {
        this.destroy(err);
        callback(err);
      }
    },
    flush(callback) {
      if (validated) return callback();
      const buffer = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      validateMimeTypeFromBuffer(buffer, filename)
        .then(result => {
          if (!result.valid) {
            callback(new Error(result.error));
            return;
          }
          if (buffer.length > 0) this.push(buffer);
          callback();
        })
        .catch(callback);
    },
  });
}

/**
 * Validates that a file's actual MIME type matches what ONLYOFFICE expects for the given extension
 * @param {string} filePath - Path to the file (or S3 key when skipContentDetection is true)
 * @param {string} filename - Filename with extension
 * @param {string} storedMimeType - MIME type stored in database
 * @param {boolean} isEncrypted - Whether the file is encrypted (can't detect MIME from encrypted content)
 * @param {boolean} [skipContentDetection=false] - When true (e.g. S3), validate using stored MIME only
 * @returns {Promise<Object>} { valid: boolean, error: string|null, actualMimeType: string|null }
 */
async function validateOnlyOfficeMimeType(
  filePath,
  filename,
  storedMimeType,
  isEncrypted = false,
  skipContentDetection = false
) {
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

  // For encrypted files or when content detection is skipped (e.g. S3), validate stored MIME type only
  if (isEncrypted || skipContentDetection) {
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

    return {
      valid: true,
      error: null,
      actualMimeType: storedMimeType,
    };
  }

  // For unencrypted files, detect actual MIME type from file content (requires local path)
  const actualMimeType = await detectMimeTypeFromContent(filePath);

  // If detection fails for unencrypted file, fall back to stored MIME type if it matches expected
  if (!actualMimeType) {
    if (storedMimeType && normalizedExpected.includes(normalizedStored)) {
      // Stored MIME type matches expected - allow (file-type might not detect all formats)
      logger.debug(
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
  validateMimeTypeFromBuffer,
  createMimeCheckStream,
  validateOnlyOfficeMimeType,
};
