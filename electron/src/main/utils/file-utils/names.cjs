/*
 * Filename and origin helpers: sanitise names for the local filesystem,
 * de-duplicate collisions, and validate an IPC-supplied origin against the
 * trusted server URL.
 */
const path = require('path');

const { getServerUrl } = require('../../config.cjs');

/**
 * Validate that an origin from an IPC payload matches the trusted server URL.
 * Returns the normalised origin (no trailing slash) or null if invalid.
 */
function validateOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return null;
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;
  try {
    const expected = new URL(serverUrl).origin;
    const received = new URL(origin).origin;
    return expected === received ? received : null;
  } catch {
    return null;
  }
}

function sanitizeFileName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'file';
}

/**
 * Append a "(n)" suffix to a filename until it's not present in the given set.
 */
function deduplicateFileName(base, seenSet) {
  if (!seenSet.has(base)) return base;
  const ext = path.extname(base);
  const stem = path.basename(base, ext) || base;
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (seenSet.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

module.exports = { validateOrigin, sanitizeFileName, deduplicateFileName };
