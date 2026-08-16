const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// The splash and error screens are data: URLs, so they live in an opaque origin
// and cannot read the web app's own `theme` key out of localStorage. The main
// process mirrors it here.
const THEME_FILE = 'ui-theme.json';

/** Matches the web app: anything other than an explicit 'light' is dark. */
const DEFAULT_THEME = 'dark';

function themeFilePath() {
  return path.join(app.getPath('userData'), THEME_FILE);
}

/** @returns {'light' | 'dark'} last known renderer theme */
function getTheme() {
  try {
    const data = JSON.parse(fs.readFileSync(themeFilePath(), 'utf8'));
    return data && data.theme === 'light' ? 'light' : DEFAULT_THEME;
  } catch (_) {
    return DEFAULT_THEME;
  }
}

/**
 * Persist the renderer's theme. Ignores anything that isn't one of the two
 * values, and skips the write when nothing changed so a normal launch does no
 * disk I/O at all.
 * @param {unknown} theme
 */
function rememberTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  if (theme === getTheme()) return;
  try {
    fs.writeFileSync(themeFilePath(), JSON.stringify({ theme }), 'utf8');
  } catch (_) {
    /* a stale theme is not worth failing a launch over */
  }
}

module.exports = { DEFAULT_THEME, getTheme, rememberTheme };
