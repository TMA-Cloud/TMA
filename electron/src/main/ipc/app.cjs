const { ipcMain, app } = require('electron');
const { downloadAndInstallUpdate } = require('../updater.cjs');
const { rememberTheme } = require('../theme.cjs');

function registerAppHandlers() {
  // The renderer reports its theme whenever it changes, so the splash and error
  // screens are already correct on the very next launch.
  ipcMain.handle('app:setTheme', async (_event, theme) => {
    rememberTheme(theme);
    return { ok: true };
  });

  ipcMain.handle('app:getVersion', async () => {
    try {
      return { version: app.getVersion() };
    } catch (e) {
      return { version: null, error: e && e.message ? e.message : 'Failed to read app version' };
    }
  });

  ipcMain.handle('app:downloadAndInstallUpdate', async (event, version) => {
    const onProgress = percent => {
      try {
        event.sender.send('app:updateDownloadProgress', percent);
      } catch (_) {
        // Renderer may be gone
      }
    };
    return downloadAndInstallUpdate(version, onProgress);
  });
}

module.exports = { registerAppHandlers };
