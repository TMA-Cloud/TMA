/*
 * Bulk transfers between the app and the native filesystem host travel via
 * shared temp files under one staging dir (matches the C# host's
 * Path.Combine(GetTempPath(), "tma-cloud-fs")). Confining src/dest paths to it
 * stops a pipe client making us read or write arbitrary files on disk.
 */
const os = require('os');
const path = require('path');

const STAGING_DIR = path.join(os.tmpdir(), 'tma-cloud-fs');

function isInStagingDir(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  const base = path.resolve(STAGING_DIR);
  const resolved = path.resolve(p);
  return resolved === base || resolved.startsWith(base + path.sep);
}

module.exports = { STAGING_DIR, isInStagingDir };
