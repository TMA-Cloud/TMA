const path = require('path');
const fs = require('fs');
const { ipcMain, shell, dialog, BrowserWindow } = require('electron');
const {
  EDIT_DIR_PREFIX,
  sanitizeFileName,
  createTempDir,
  downloadToFile,
  downloadPostToFile,
  uploadFileToReplace,
  uploadDerivedFile,
  hashFile,
} = require('../utils/file-utils.cjs');

const SAVE_DIALOG_TITLE = 'TMA Cloud';

// Minimum file size (in bytes) to consider caching between edit sessions (~6 MB).
const EDIT_CACHE_MIN_BYTES = 6 * 1024 * 1024;

// In-memory cache of large files that have already been downloaded for desktop editing.
// Keyed by file id.
// NOTE: This cache only lives for the lifetime of the Electron process and is always
// revalidated against fresh backend metadata (size + modified) before reuse.
const editCache = new Map();

// Recently uploaded derived files keyed by "originalId|size" to avoid duplicate uploads
// when multiple watchers or rapid fs events fire for the same exported document.
const recentDerivedUploads = new Map();

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
      const win = BrowserWindow.fromWebContents(_event.sender);
      const fileId = String(item.id);
      const downloadUrl = `${base}/api/files/${encodeURIComponent(fileId)}/download`;

      let remoteInfo = null;
      try {
        // Fetch latest backend metadata so we can safely decide whether a cached
        // temp file is still identical to the cloud version.
        remoteInfo = await require('../utils/file-utils.cjs').getFileInfoFromBackend(base, fileId);
      } catch {
        remoteInfo = null;
      }

      const remoteSize = remoteInfo && remoteInfo.size != null ? Number(remoteInfo.size) || 0 : null;
      const remoteModifiedMs =
        remoteInfo && remoteInfo.modified != null ? new Date(remoteInfo.modified).getTime() : null;

      let editDir;
      let filePath;

      const cacheKey = fileId;
      const cached = editCache.get(cacheKey);

      const canReuseFromCache =
        cached &&
        typeof remoteSize === 'number' &&
        remoteSize >= EDIT_CACHE_MIN_BYTES &&
        cached.remoteSize === remoteSize &&
        cached.remoteModifiedMs === remoteModifiedMs &&
        fs.existsSync(cached.filePath);

      if (canReuseFromCache) {
        editDir = cached.editDir;
        filePath = cached.filePath;
      } else {
        editDir = createTempDir(EDIT_DIR_PREFIX);
        filePath = path.join(editDir, sanitizeFileName(String(item.name)));

        try {
          await downloadToFile(downloadUrl, filePath);
        } catch (e) {
          return {
            ok: false,
            error: e && e.message ? e.message : 'Failed to download file',
          };
        }

        if (typeof remoteSize === 'number' && remoteSize >= EDIT_CACHE_MIN_BYTES) {
          editCache.set(cacheKey, {
            editDir,
            filePath,
            remoteSize,
            remoteModifiedMs,
          });
        }
      }

      let lastHash = null;
      let lastUploadTime = 0;
      const THROTTLE_MS = 5000;
      let watcher = null;
      let dirWatcher = null;
      const derivedDebounceTimers = new Map();
      const derivedUploadsInProgress = new Set();
      let uploadInProgress = false;
      const originalBaseName = path.basename(filePath);

      try {
        lastHash = await hashFile(filePath);
      } catch {
        lastHash = null;
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

      // Auto-upload derived files saved in the same temp edit directory (e.g. "Save as", "Export" from Office)
      try {
        dirWatcher = fs.watch(editDir, (_eventType, changedFileName) => {
          if (!changedFileName) return;
          const name = String(changedFileName);
          const ext = path.extname(name).toLowerCase();
          // Ignore Office lock/temporary files (e.g. "~$document.docx")
          if (name.startsWith('~$')) return;
          // The main file (originalBaseName) is handled by the file-specific watcher above,
          // which correctly calls the replace endpoint. Here we only want truly "derived"
          // files such as exports or "Save As" with a different name.
          if (name === originalBaseName) return;

          const allowedDerivedExts = new Set([
            '.pdf',
            '.docx',
            '.doc',
            '.docm',
            '.rtf',
            '.odt',
            '.txt',
            '.html',
            '.mht',
            '.xlsx',
            '.xls',
            '.xlsm',
            '.csv',
            '.pptx',
            '.ppt',
            '.pptm',
            '.odp',
          ]);
          if (!allowedDerivedExts.has(ext)) return;

          const derivedPath = path.join(editDir, name);

          // Debounce uploads per derived file to avoid multiple triggers from fs.watch.
          // Only start the upload after the file has been stable for a short period.
          const key = derivedPath;
          const existingTimer = derivedDebounceTimers.get(key);
          if (existingTimer) {
            clearTimeout(existingTimer);
          }

          const DEBOUNCE_MS = 1500;
          const timer = setTimeout(async () => {
            derivedDebounceTimers.delete(key);

            // Avoid double uploads if one is already running for this file
            if (derivedUploadsInProgress.has(key)) {
              return;
            }
            derivedUploadsInProgress.add(key);

            try {
              // Wait a bit more to reduce chances of reading a still-writing file
              await new Promise(resolve => setTimeout(resolve, 50));

              const stats = await fs.promises.stat(derivedPath).catch(() => null);
              const size = stats?.size;

              // Deduplicate very recent derived uploads for the same original file and size.
              // This protects against multiple fs.watch events or leaked watchers causing
              // the same export to be uploaded multiple times in quick succession.
              const dedupeKey = `${item.id}|${size || 0}`;
              const now = Date.now();
              const lastUpload = recentDerivedUploads.get(dedupeKey);
              const DEDUPE_WINDOW_MS = 5000;
              if (lastUpload && now - lastUpload < DEDUPE_WINDOW_MS) {
                return;
              }
              recentDerivedUploads.set(dedupeKey, now);

              if (win && !win.isDestroyed()) {
                win.webContents.send('files:derivedUploadStatus', {
                  state: 'started',
                  fileName: name,
                  size,
                  originalId: String(item.id),
                });
              }

              await uploadDerivedFile(base, String(item.id), derivedPath, name);

              if (win && !win.isDestroyed()) {
                win.webContents.send('files:derivedUploadStatus', {
                  state: 'completed',
                  fileName: name,
                  size,
                  originalId: String(item.id),
                });
              }
            } catch (err) {
              if (win && !win.isDestroyed()) {
                win.webContents.send('files:derivedUploadStatus', {
                  state: 'error',
                  fileName: name,
                  originalId: String(item.id),
                  error: err && err.message ? err.message : 'Failed to upload derived file',
                });
              }
            } finally {
              derivedUploadsInProgress.delete(key);
            }
          }, DEBOUNCE_MS);

          derivedDebounceTimers.set(key, timer);
        });
        dirWatcher.on('error', () => {
          try {
            dirWatcher.close();
          } catch {
            /* ignore */
          }
        });
      } catch {
        dirWatcher = null;
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

function registerSaveFileHandlers() {
  ipcMain.handle('files:saveFile', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return { ok: false, error: 'No window' };
    }
    const origin = typeof payload?.origin === 'string' ? payload.origin.replace(/\/$/, '') : '';
    const fileId = payload?.fileId;
    const suggestedFileName = typeof payload?.suggestedFileName === 'string' ? payload.suggestedFileName : 'download';
    if (!origin || !fileId) {
      return { ok: false, error: 'Invalid payload' };
    }
    const safeName = sanitizeFileName(suggestedFileName);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: SAVE_DIALOG_TITLE,
      defaultPath: safeName,
    });
    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }
    const downloadUrl = `${origin}/api/files/${encodeURIComponent(String(fileId))}/download`;
    try {
      await downloadToFile(downloadUrl, filePath);
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : 'Failed to download file',
      };
    }
  });

  ipcMain.handle('files:saveFilesBulk', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return { ok: false, error: 'No window' };
    }
    const origin = typeof payload?.origin === 'string' ? payload.origin.replace(/\/$/, '') : '';
    const ids = Array.isArray(payload?.ids) ? payload.ids.filter(id => id != null) : [];
    if (!origin || ids.length === 0) {
      return { ok: false, error: 'Invalid payload' };
    }
    const defaultPath = `download_${Date.now()}.zip`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: SAVE_DIALOG_TITLE,
      defaultPath,
    });
    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }
    const bulkUrl = `${origin}/api/files/download/bulk`;
    try {
      await downloadPostToFile(bulkUrl, { ids }, filePath);
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : 'Failed to download files',
      };
    }
  });
}

module.exports = { registerEditWithDesktopHandler, registerSaveFileHandlers };
