const path = require('path');
const { app } = require('electron');

const { getServerUrl, NO_SERVER_URL_PAGE } = require('./config.cjs');
const { createWindow, getMainWindow } = require('./window.cjs');
const { registerClipboardHandlers } = require('./ipc/clipboard.cjs');
const { registerAppHandlers } = require('./ipc/app.cjs');
const { registerEditWithDesktopHandler, registerSaveFileHandlers } = require('./ipc/files.cjs');
const { cleanTempClipboardDirs, cleanTempEditDirs } = require('./utils/file-utils.cjs');

// Single instance: if another instance is already running, focus it and quit this one
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  const win = getMainWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// Register IPC handlers before any window is created
registerClipboardHandlers();
registerAppHandlers();
registerEditWithDesktopHandler();
registerSaveFileHandlers();

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
