const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
});
