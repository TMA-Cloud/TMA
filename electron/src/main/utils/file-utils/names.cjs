/*
 * Filename and origin helpers: sanitise names for the local filesystem,
 * de-duplicate collisions, flag types Windows would execute, and validate an
 * IPC-supplied origin against the trusted server URL.
 */
const path = require('path');

const { getServerUrl } = require('../../config.cjs');

// Types the shell runs as code rather than opening as a document (Windows
// Attachment Manager's high-risk list plus installers, scripts and shortcuts).
const EXECUTABLE_EXTS = new Set([
  '.appinstaller',
  '.application',
  '.appref-ms',
  '.appx',
  '.appxbundle',
  '.bat',
  '.chm',
  '.cmd',
  '.com',
  '.cpl',
  '.diagcab',
  '.exe',
  '.gadget',
  '.hta',
  '.inf',
  '.ins',
  '.isp',
  '.jar',
  '.jnlp',
  '.js',
  '.jse',
  '.library-ms',
  '.lnk',
  '.msc',
  '.msi',
  '.msix',
  '.msixbundle',
  '.msp',
  '.mst',
  '.pif',
  '.ps1',
  '.ps1xml',
  '.ps2',
  '.ps2xml',
  '.psc1',
  '.psc2',
  '.psd1',
  '.psm1',
  '.reg',
  '.scf',
  '.scr',
  '.sct',
  '.search-ms',
  '.searchconnector-ms',
  '.settingcontent-ms',
  '.shb',
  '.shs',
  '.url',
  '.vb',
  '.vbe',
  '.vbs',
  '.ws',
  '.wsc',
  '.wsf',
  '.wsh',
  '.xll',
]);

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

/** True when opening this name through the shell would run it as a program. */
function isExecutableFileName(name) {
  // Windows drops trailing dots and spaces, so "setup.exe. " is still an .exe.
  const trimmed = String(name || '').replace(/[. ]+$/, '');
  return EXECUTABLE_EXTS.has(path.extname(trimmed).toLowerCase());
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

module.exports = { validateOrigin, sanitizeFileName, deduplicateFileName, isExecutableFileName };
