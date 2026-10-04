/*
 * Every IPC handler touches the user's files, clipboard or session, so each call
 * must come from a frame on the configured server's origin. Handlers used to
 * trust an `origin` string the renderer itself sent, which any page that ended
 * up in the window could forge. Patching ipcMain once covers every handler,
 * including ones added later (Electron security checklist: validate senders).
 */
const { ipcMain } = require('electron');

const { getServerUrl } = require('./config.cjs');

function isTrustedSender(event) {
  const frameUrl = event?.senderFrame?.url;
  const serverUrl = getServerUrl();
  if (!frameUrl || !serverUrl) return false;
  try {
    return new URL(frameUrl).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function installIpcSenderGuard() {
  if (ipcMain.__senderGuarded) return;
  const handle = ipcMain.handle.bind(ipcMain);
  const on = ipcMain.on.bind(ipcMain);

  ipcMain.handle = (channel, handler) =>
    handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) {
        console.warn(`[ipc] rejected "${channel}" from untrusted frame`);
        throw new Error('Untrusted IPC sender');
      }
      return handler(event, ...args);
    });

  ipcMain.on = (channel, listener) =>
    on(channel, (event, ...args) => {
      if (!isTrustedSender(event)) {
        console.warn(`[ipc] dropped "${channel}" from untrusted frame`);
        return;
      }
      listener(event, ...args);
    });

  ipcMain.__senderGuarded = true;
}

module.exports = { installIpcSenderGuard };
