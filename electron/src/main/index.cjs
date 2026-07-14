const path = require('path');
const { app } = require('electron');

const { getServerUrl, NO_SERVER_URL_PAGE } = require('./config.cjs');
const { createWindow, getMainWindow } = require('./window.cjs');
const { registerClipboardHandlers } = require('./ipc/clipboard.cjs');
const { registerAppHandlers } = require('./ipc/app.cjs');
const { registerEditWithDesktopHandler, registerSaveFileHandlers, getActiveEditDirs } = require('./ipc/files.cjs');
const { cleanTempClipboardDirs, cleanTempEditDirs } = require('./utils/file-utils.cjs');
const { registerCloudDriveHandlers, watchAuthAndMount, stopCloudDrive } = require('./clouddrive.cjs');

let cleanupInterval = null;

// Ensure a stable identity + storage location on Windows so auth cookies persist across
// upgrades/reinstalls (and don't vary with install directory / portable location).
// Must run before app.whenReady().
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.tmacloud.app');
  } catch (_) {
    /* ignore */
  }
}

// app.getPath('userData') is derived from app name + platform-specific appData.
// Being explicit here prevents "login reset" when name/path resolution changes.
try {
  const stableUserData = path.join(app.getPath('appData'), 'TMA Cloud');
  app.setPath('userData', stableUserData);
} catch (_) {
  /* ignore */
}

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
// Cloud Drive (WinFsp): renderer starts/stops it based on auth state.
if (process.platform === 'win32') {
  registerCloudDriveHandlers();
}

app.whenReady().then(() => {
  const serverUrl = getServerUrl();
  const loadUrl = serverUrl || NO_SERVER_URL_PAGE;
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.cjs');
  const appRoot = app.getAppPath();

  createWindow(loadUrl, preloadPath, appRoot);

  // Auto-mount the cloud drive based on the auth cookie (no frontend needed).
  if (process.platform === 'win32') {
    watchAuthAndMount();
  }

  const CLEAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  cleanupInterval = setInterval(() => {
    if (process.platform === 'win32') {
      cleanTempClipboardDirs(MAX_AGE_MS);
      cleanTempEditDirs(MAX_AGE_MS, getActiveEditDirs());
    }
  }, CLEAN_INTERVAL_MS);
  // Allow the app to exit even if this timer is still pending.
  cleanupInterval.unref();
});

app.on('before-quit', () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (process.platform === 'win32') {
    // Unmount the cloud drive so no orphaned WinFsp host lingers.
    stopCloudDrive();
  }
  if (process.platform === 'win32') {
    cleanTempClipboardDirs(0);
    // Still pass the exclusion set: files.cjs before-quit runs too and may not
    // have fired yet when this handler runs (order is not guaranteed).
    cleanTempEditDirs(0, getActiveEditDirs());
  }
});

app.on('window-all-closed', () => app.quit());
