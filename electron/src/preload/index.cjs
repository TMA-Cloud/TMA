const { contextBridge, ipcRenderer } = require('electron');

(function () {
  try {
    const api = {
      platform: process.platform,
      app: {
        getVersion: () => ipcRenderer.invoke('app:getVersion'),
        downloadAndInstallUpdate: version => ipcRenderer.invoke('app:downloadAndInstallUpdate', version),
        onUpdateDownloadProgress: callback => {
          if (typeof callback !== 'function') return () => {};
          const listener = (_e, percent) => callback(percent);
          ipcRenderer.on('app:updateDownloadProgress', listener);
          return () => ipcRenderer.removeListener('app:updateDownloadProgress', listener);
        },
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
        /**
         * Subscribe to status updates for derived uploads (e.g. exported PDFs).
         * Returns an unsubscribe function.
         */
        onDerivedUploadStatus: callback => {
          if (typeof callback !== 'function') return () => {};
          const listener = (_event, payload) => {
            try {
              callback(payload);
            } catch (err) {
              console.error('[Electron preload] Error in onDerivedUploadStatus callback:', err);
            }
          };
          ipcRenderer.on('files:derivedUploadStatus', listener);
          return () => {
            ipcRenderer.removeListener('files:derivedUploadStatus', listener);
          };
        },
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
