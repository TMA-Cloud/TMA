const { contextBridge, ipcRenderer } = require('electron');

(function () {
  try {
    const api = {
      platform: process.platform,
      app: {
        getVersion: () => ipcRenderer.invoke('app:getVersion'),
      },
      clipboard: {
        readFiles: () => ipcRenderer.invoke('clipboard:readFiles'),
        writeFiles: paths => ipcRenderer.invoke('clipboard:writeFiles', paths),
        writeFilesFromData: payload => ipcRenderer.invoke('clipboard:writeFilesFromData', payload),
        writeFilesFromServer: payload => ipcRenderer.invoke('clipboard:writeFilesFromServer', payload),
      },
      files: {
        editWithDesktop: payload => ipcRenderer.invoke('files:editWithDesktop', payload),
        saveFile: payload => ipcRenderer.invoke('files:saveFile', payload),
        saveFilesBulk: payload => ipcRenderer.invoke('files:saveFilesBulk', payload),
      },
    };
    contextBridge.exposeInMainWorld('electronAPI', api);
  } catch (err) {
    console.error('[Electron preload] Failed to expose electronAPI:', err);
    contextBridge.exposeInMainWorld('electronAPI', {
      platform: process.platform,
      clipboard: {},
      files: {},
    });
  }
})();
