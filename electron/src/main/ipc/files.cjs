const path = require('path');
const fs = require('fs');
const { ipcMain, shell } = require('electron');
const {
  EDIT_DIR_PREFIX,
  sanitizeFileName,
  createTempDir,
  downloadToFile,
  uploadFileToReplace,
  hashFile,
} = require('../utils/file-utils.cjs');

function registerEditWithDesktopHandler() {
  ipcMain.handle('files:editWithDesktop', async (_event, payload) => {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Desktop editing is only supported on Windows' };
    }

    try {
      const origin = typeof payload?.origin === 'string' ? payload.origin : '';
      const item = payload?.item;
      if (!origin || !item || !item.id || !item.name) {
        return { ok: false, error: 'Invalid payload' };
      }

      const base = origin.replace(/\/$/, '');
      const downloadUrl = `${base}/api/files/${encodeURIComponent(String(item.id))}/download`;

      const editDir = createTempDir(EDIT_DIR_PREFIX);
      const filePath = path.join(editDir, sanitizeFileName(String(item.name)));

      let lastHash = null;
      let lastUploadTime = 0;
      const THROTTLE_MS = 5000;
      let watcher = null;
      let uploadInProgress = false;

      try {
        await downloadToFile(downloadUrl, filePath);
        try {
          lastHash = await hashFile(filePath);
        } catch {
          lastHash = null;
        }
      } catch (e) {
        return {
          ok: false,
          error: e && e.message ? e.message : 'Failed to download file',
        };
      }

      async function uploadIfChangedThrottled() {
        const now = Date.now();
        if (now - lastUploadTime < THROTTLE_MS) return;

        if (uploadInProgress) return;
        uploadInProgress = true;

        let newHash;
        try {
          newHash = await hashFile(filePath);
        } catch {
          uploadInProgress = false;
          return;
        }

        if (lastHash && newHash && lastHash === newHash) {
          uploadInProgress = false;
          return;
        }

        try {
          await uploadFileToReplace(base, String(item.id), filePath, String(item.name));
          lastHash = newHash;
          lastUploadTime = Date.now();
        } catch {
          // Silently ignore upload errors here; backend/logs can capture them
        } finally {
          uploadInProgress = false;
        }
      }

      try {
        watcher = fs.watch(filePath, () => {
          void uploadIfChangedThrottled();
        });
        watcher.on('error', () => {
          try {
            watcher.close();
          } catch {
            /* ignore */
          }
        });
      } catch {
        watcher = null;
      }

      try {
        const errorMessage = await shell.openPath(filePath);
        if (errorMessage) {
          return {
            ok: false,
            error: errorMessage,
          };
        }
      } catch (e) {
        return {
          ok: false,
          error: e && e.message ? e.message : 'Failed to open file with default application',
        };
      }

      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : 'Unexpected error',
      };
    }
  });
}

module.exports = { registerEditWithDesktopHandler };
