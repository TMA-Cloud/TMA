const { ipcRenderer } = require('electron');

/**
 * Reference shape for the Electron API. The live implementation is inlined in
 * index.cjs so the preload is a single file. Channel names and shapes must
 * match the handlers in the main process (src/main/ipc/).
 */
function createElectronAPI() {
  return {
    platform: process.platform,
    clipboard: {
      readFiles: () => ipcRenderer.invoke('clipboard:readFiles'),
      writeFiles: paths => ipcRenderer.invoke('clipboard:writeFiles', paths),
      writeFilesFromData: payload => ipcRenderer.invoke('clipboard:writeFilesFromData', payload),
      writeFilesFromServer: payload => ipcRenderer.invoke('clipboard:writeFilesFromServer', payload),
    },
    files: {
      editWithDesktop: payload => ipcRenderer.invoke('files:editWithDesktop', payload),
    },
  };
}

module.exports = { createElectronAPI };
