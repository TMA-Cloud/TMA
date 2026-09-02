/*
 * Drive behavior mode, persisted per-device in <userData>/clouddrive-config.json.
 *   'full'     - files can be opened/read from the drive
 *   'saveOnly' - browse + Save-As only; reading file content is denied (default)
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function modeConfigPath() {
  try {
    return path.join(app.getPath('userData'), 'clouddrive-config.json');
  } catch {
    return null;
  }
}

function getMode() {
  try {
    const p = modeConfigPath();
    if (p && fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      return cfg && cfg.mode === 'full' ? 'full' : 'saveOnly';
    }
  } catch {
    /* ignore */
  }
  return 'saveOnly';
}

function persistMode(mode) {
  try {
    const p = modeConfigPath();
    if (p) fs.writeFileSync(p, JSON.stringify({ mode }));
  } catch {
    /* ignore */
  }
}

module.exports = { getMode, persistMode };
