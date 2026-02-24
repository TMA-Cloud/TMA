const path = require('path');
const { app } = require('electron');

const { getServerUrl, NO_SERVER_URL_PAGE } = require('./config.cjs');
const { createWindow } = require('./window.cjs');
const { registerClipboardHandlers } = require('./ipc/clipboard.cjs');
const { registerEditWithDesktopHandler } = require('./ipc/files.cjs');
const { cleanTempClipboardDirs, cleanTempEditDirs } = require('./utils/file-utils.cjs');

// Register IPC handlers before any window is created
registerClipboardHandlers();
registerEditWithDesktopHandler();

app.whenReady().then(() => {
  const serverUrl = getServerUrl();
  const loadUrl = serverUrl || NO_SERVER_URL_PAGE;
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.cjs');
  const appRoot = app.getAppPath();

  createWindow(loadUrl, preloadPath, appRoot);

  const CLEAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  setInterval(() => {
    if (process.platform === 'win32') {
      cleanTempClipboardDirs(MAX_AGE_MS);
      cleanTempEditDirs(MAX_AGE_MS);
    }
  }, CLEAN_INTERVAL_MS);
});

app.on('before-quit', () => {
  if (process.platform === 'win32') {
    cleanTempClipboardDirs(0);
    cleanTempEditDirs(0);
  }
});

app.on('window-all-closed', () => app.quit());
