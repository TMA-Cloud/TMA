/*
 * Cloud-drive logging. The main-process console is invisible in a packaged app,
 * so mirror logs to <userData>/clouddrive.log for troubleshooting.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function logFilePath() {
  try {
    return path.join(app.getPath('userData'), 'clouddrive.log');
  } catch {
    return null;
  }
}

function writeLog(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  const f = logFilePath();
  if (!f) return;
  try {
    fs.appendFileSync(f, line);
  } catch {
    /* ignore */
  }
}

function log(...a) {
  console.log('[clouddrive]', ...a);
  writeLog('info', a);
}

function warn(...a) {
  console.warn('[clouddrive]', ...a);
  writeLog('warn', a);
}

module.exports = { log, warn };
