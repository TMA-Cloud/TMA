/*
 * Extension -> MIME type for the main process, backed by the `mime-types`
 * library with a small OVERRIDES map for extensions where we prefer a
 * broader/more-specific value.
 */
const path = require('path');

const mime = require('mime-types');

const DEFAULT_MIME = 'application/octet-stream';

// Overrides for extensions where the library's value is less compatible or
// less specific than we want (ico, m4v, opus, flac).
const OVERRIDES = {
  ico: 'image/x-icon',
  m4v: 'video/mp4',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

// Best-effort MIME type for a filename; null when the extension is unknown.
function mimeForFilename(name) {
  const ext = path
    .extname(String(name || ''))
    .slice(1)
    .toLowerCase();
  if (!ext) return null;
  return OVERRIDES[ext] || mime.lookup(ext) || null;
}

// Like mimeForFilename but always returns a usable Content-Type
// (application/octet-stream for unknown extensions).
function mimeForFilenameOrDefault(name) {
  return mimeForFilename(name) || DEFAULT_MIME;
}

module.exports = {
  DEFAULT_MIME,
  mimeForFilename,
  mimeForFilenameOrDefault,
};
