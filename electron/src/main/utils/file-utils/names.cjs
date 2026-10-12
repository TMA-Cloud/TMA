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

// Microsoft's "Naming Files" rules: reserved characters and controls, device
// names (also with an extension or a superscript digit), and a trailing dot or space.
// eslint-disable-next-line no-control-regex -- Intentional: Windows refuses control characters
const WINDOWS_RESERVED_CHARS = /[/\\:*?"<>|\x00-\x1F]/g;
const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)/i;

/** A name Windows and Explorer can create, for a stored name that may not be one. */
function sanitizeFileName(name) {
  const safe = String(name)
    .replace(WINDOWS_RESERVED_CHARS, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!safe) return 'file';
  return WINDOWS_DEVICE_NAME.test(safe) ? `_${safe}` : safe;
}

/** Explorer still cannot paste from a path past MAX_PATH unless long paths are enabled. */
const MAX_SHELL_PATH = 259;

/** Shorten the stem so dir\name stays within MAX_PATH, keeping the extension; `reserve` leaves room for a " (n)" suffix. */
function fitFileName(dir, name, reserve = 0) {
  const room = MAX_SHELL_PATH - dir.length - 1 - reserve;
  if (name.length <= room) return name;
  const ext = path.extname(name);
  const keep = Math.max(1, room - ext.length);
  // Array.from counts code points, so an emoji is never cut in half.
  return (
    Array.from(path.basename(name, ext))
      .slice(0, keep)
      .join('')
      .replace(/[. ]+$/, '') + ext
  );
}

/** True when opening this name through the shell would run it as a program. */
function isExecutableFileName(name) {
  // Windows drops trailing dots and spaces, so "setup.exe. " is still an .exe.
  const trimmed = String(name || '').replace(/[. ]+$/, '');
  return EXECUTABLE_EXTS.has(path.extname(trimmed).toLowerCase());
}

/**
 * Append a "(n)" suffix to a filename until it's not present in the given set.
 * Case is ignored, as NTFS ignores it: "A.txt" and "a.txt" are one file there.
 */
function deduplicateFileName(base, seenSet) {
  const taken = new Set([...seenSet].map(name => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const ext = path.extname(base);
  const stem = path.basename(base, ext) || base;
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (taken.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

module.exports = { validateOrigin, sanitizeFileName, fitFileName, deduplicateFileName, isExecutableFileName };
