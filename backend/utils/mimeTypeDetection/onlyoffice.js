/**
 * OnlyOffice MIME validation: map a file extension to every MIME type the
 * official DB (plus a curated alias table for Office/OLE quirks) considers
 * valid, then confirm the stored or content-detected type is one of them. Kept
 * apart from the generic detection in ./core.js because the alias tables and
 * the "what does OnlyOffice accept" policy are a concern of their own.
 */

import path from 'path';

import mime from 'mime-types';
import mimeDb from 'mime-db';

import { logger } from '../../config/logger.js';
import { detectMimeTypeFromContent, normalizeMime } from './core.js';

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
  // .doc (Word 97-2003) is CFB/OLE; file-type reports application/x-cfb
  doc: [
    'application/msword',
    'application/x-msword',
    'application/vnd.ms-word',
    'application/vnd.ms-word.document.macroEnabled.12',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/x-cfb',
  ],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.ms-word.document.macroEnabled.12',
  ],
  docm: ['application/vnd.ms-word.document.macroEnabled.12'],
  dot: ['application/msword', 'application/x-msword', 'application/x-cfb'],
  dotx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.template'],
  dotm: ['application/vnd.ms-word.template.macroEnabled.12'],

  // Rich Text (opened by Word and other editors)
  rtf: ['application/rtf', 'text/rtf'],

  // --- Microsoft Excel formats ---
  // .xls (Excel 97-2003) is CFB/OLE; file-type reports application/x-cfb
  xls: [
    'application/vnd.ms-excel',
    'application/msexcel',
    'application/x-msexcel',
    'application/x-ms-excel',
    'application/x-excel',
    'application/x-dos_ms_excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/x-cfb',
  ],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
  xlsm: ['application/vnd.ms-excel.sheet.macroEnabled.12'],
  xlsb: ['application/vnd.ms-excel.sheet.binary.macroEnabled.12'],
  xltx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.template'],
  xltm: ['application/vnd.ms-excel.template.macroEnabled.12'],

  // --- Microsoft PowerPoint formats ---
  // .ppt / .pps (PowerPoint 97-2003) are CFB/OLE; file-type reports application/x-cfb
  ppt: [
    'application/vnd.ms-powerpoint',
    'application/mspowerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    'application/x-cfb',
  ],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'],
  pptm: ['application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
  pps: ['application/vnd.ms-powerpoint', 'application/x-cfb'],
  ppsx: ['application/vnd.openxmlformats-officedocument.presentationml.slideshow'],
  ppsm: ['application/vnd.ms-powerpoint.slideshow.macroEnabled.12'],
  potx: ['application/vnd.openxmlformats-officedocument.presentationml.template'],
  potm: ['application/vnd.ms-powerpoint.template.macroEnabled.12'],
  pot: ['application/vnd.ms-powerpoint', 'application/x-cfb'],

  // --- OpenDocument formats (also commonly edited in Office) ---
  odt: ['application/vnd.oasis.opendocument.text'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet'],
  odp: ['application/vnd.oasis.opendocument.presentation'],

  // PDF (some clients send non-standard aliases)
  pdf: ['application/x-pdf', 'application/acrobat', 'application/vnd.pdf', 'text/pdf', 'text/x-pdf'],

  // SVG is XML-based; file-type reports application/xml for SVGs without an XML declaration
  svg: ['application/xml', 'text/xml'],
};

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

export { getExpectedMimeTypesForExtension, validateOnlyOfficeMimeType };
