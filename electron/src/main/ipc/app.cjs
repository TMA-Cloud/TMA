const { ipcMain, app } = require('electron');

function registerAppHandlers() {
  ipcMain.handle('app:getVersion', async () => {
    try {
      return { version: app.getVersion() };
    } catch (e) {
      return { version: null, error: e && e.message ? e.message : 'Failed to read app version' };
    }
  });
}

module.exports = { registerAppHandlers };
