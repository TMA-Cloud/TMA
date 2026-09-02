/*
 * Temp-directory helpers: create per-session working directories and sweep old
 * ones. Paste and desktop-edit sessions each stage files under a prefixed temp
 * dir so they can be cleaned up by age without touching unrelated files.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const PASTE_DIR_PREFIX = 'tma-cloud-paste-';
const EDIT_DIR_PREFIX = 'tma-cloud-edit-';

function createTempDir(prefix) {
  const tmpRoot = os.tmpdir();
  const dir = path.join(tmpRoot, `${prefix}${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTempDirsByPrefix(prefix, maxAgeMs, excludeDirs) {
  const tmpRoot = os.tmpdir();
  const now = Date.now();
  const exclude = excludeDirs instanceof Set ? excludeDirs : null;
  try {
    const existing = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const e of existing) {
      if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
      const dirPath = path.join(tmpRoot, e.name);
      // Skip directories that are still in use by an active session.
      if (exclude && exclude.has(dirPath)) continue;
      try {
        const stat = fs.statSync(dirPath);
        const age = now - stat.mtimeMs;
        if (age >= maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function cleanTempClipboardDirs(maxAgeMs, excludeDirs) {
  cleanTempDirsByPrefix(PASTE_DIR_PREFIX, maxAgeMs, excludeDirs);
}

function cleanTempEditDirs(maxAgeMs, excludeDirs) {
  cleanTempDirsByPrefix(EDIT_DIR_PREFIX, maxAgeMs, excludeDirs);
}

module.exports = {
  PASTE_DIR_PREFIX,
  EDIT_DIR_PREFIX,
  createTempDir,
  cleanTempDirsByPrefix,
  cleanTempClipboardDirs,
  cleanTempEditDirs,
};
