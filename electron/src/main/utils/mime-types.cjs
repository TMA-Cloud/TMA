/**
 * Single source of truth for extension -> MIME type in the Electron main process.
 *
 * Backed by the `mime-types` npm library so the table stays current.
 * A small OVERRIDES map pins the few extensions where we deliberately
 * prefer a different value than the library
 * returns (broader compatibility / more specific type).
 */
const path = require('path');

const mime = require('mime-types');

const DEFAULT_MIME = 'application/octet-stream';

/**
 * Extensions where we intentionally override the library:
 *   ico  - library returns image/vnd.microsoft.icon; image/x-icon is more widely recognized
 *   m4v  - library returns video/x-m4v; video/mp4 is safer/more broadly playable
 *   opus - library returns audio/ogg; audio/opus is the specific, correct type
 *   flac - library returns audio/x-flac; audio/flac is the modern registered type
 */
const OVERRIDES = {
  ico: 'image/x-icon',
  m4v: 'video/mp4',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

/**
 * Best-effort MIME type for a filename.
 * @param {string} name - filename or path
 * @returns {string|null} the mapped MIME type, or null when the extension is unknown
 */
function mimeForFilename(name) {
  const ext = path
    .extname(String(name || ''))
    .slice(1)
    .toLowerCase();
  if (!ext) return null;
  return OVERRIDES[ext] || mime.lookup(ext) || null;
}

/**
 * Like mimeForFilename but always returns a usable Content-Type,
 * falling back to application/octet-stream for unknown extensions.
 * @param {string} name - filename or path
 * @returns {string}
 */
function mimeForFilenameOrDefault(name) {
  return mimeForFilename(name) || DEFAULT_MIME;
}

module.exports = {
  DEFAULT_MIME,
  mimeForFilename,
  mimeForFilenameOrDefault,
};
