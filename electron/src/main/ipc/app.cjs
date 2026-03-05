const { ipcMain, app } = require('electron');
const { downloadAndInstallUpdate } = require('../updater.cjs');

function registerAppHandlers() {
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
