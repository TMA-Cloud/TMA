/*
 * files:editWithDesktop — download a cloud file to a temp dir, open it in its
 * default app, and watch for changes: the file itself is re-uploaded (replace),
 * and "Save As"/export siblings in the same dir are uploaded as derived files.
 */
const path = require('path');
const fs = require('fs');
const { ipcMain, shell, BrowserWindow } = require('electron');
const {
  EDIT_DIR_PREFIX,
  sanitizeFileName,
  createTempDir,
  downloadToFile,
  uploadFileToReplace,
  uploadDerivedFile,
  hashFile,
  validateOrigin,
  getFileInfoFromBackend,
} = require('../../utils/file-utils.cjs');

// Office lock/temp files (~$doc.docx) and the set of real export extensions.
const ALLOWED_DERIVED_EXTS = new Set([
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

// Resolve the local edit file: reuse a valid cached download for large files,
// otherwise download fresh (and cache when big enough).
async function resolveEditFile(registry, base, item, downloadUrl) {
  const { editCache, EDIT_CACHE_MIN_BYTES } = registry;
  const fileId = String(item.id);

  let remoteInfo = null;
  try {
    remoteInfo = await getFileInfoFromBackend(base, fileId);
  } catch {
    /* fall back to a fresh download */
  }
  const remoteSize = remoteInfo && remoteInfo.size != null ? Number(remoteInfo.size) || 0 : null;
  const remoteModifiedMs = remoteInfo && remoteInfo.modified != null ? new Date(remoteInfo.modified).getTime() : null;

  const cached = editCache.get(fileId);
  const canReuse =
    cached &&
    typeof remoteSize === 'number' &&
    remoteSize >= EDIT_CACHE_MIN_BYTES &&
    cached.remoteSize === remoteSize &&
    cached.remoteModifiedMs === remoteModifiedMs &&
    fs.existsSync(cached.filePath);

  if (canReuse) return { editDir: cached.editDir, filePath: cached.filePath };

  const editDir = createTempDir(EDIT_DIR_PREFIX);
  const filePath = path.join(editDir, sanitizeFileName(String(item.name)));
  await downloadToFile(downloadUrl, filePath);

  if (typeof remoteSize === 'number' && remoteSize >= EDIT_CACHE_MIN_BYTES) {
    editCache.set(fileId, { editDir, filePath, remoteSize, remoteModifiedMs });
  }
  return { editDir, filePath };
}

// Watch the edit dir for exported/"Save As" siblings and upload them as derived
// files, debounced and de-duplicated per original+size.
function startDerivedWatcher(registry, { editDir, originalBaseName, base, item, win }) {
  const { recentDerivedUploads } = registry;
  const derivedDebounceTimers = new Map();
  const derivedUploadsInProgress = new Set();

  const send = payload => {
    if (win && !win.isDestroyed()) win.webContents.send('files:derivedUploadStatus', payload);
  };

  let dirWatcher;
  try {
    dirWatcher = fs.watch(editDir, (_eventType, changedFileName) => {
      if (!changedFileName) return;
      const name = String(changedFileName);
      const ext = path.extname(name).toLowerCase();
      if (name.startsWith('~$')) return; // Office lock file
      if (name === originalBaseName) return; // handled by the main-file watcher
      if (!ALLOWED_DERIVED_EXTS.has(ext)) return;

      const derivedPath = path.join(editDir, name);
      const key = derivedPath;
      const existingTimer = derivedDebounceTimers.get(key);
      if (existingTimer) clearTimeout(existingTimer);

      const DEBOUNCE_MS = 1500;
      const timer = setTimeout(async () => {
        derivedDebounceTimers.delete(key);
        if (derivedUploadsInProgress.has(key)) return;
        derivedUploadsInProgress.add(key);
        try {
          // Let a still-writing file settle before reading it.
          await new Promise(resolve => setTimeout(resolve, 50));
          const stats = await fs.promises.stat(derivedPath).catch(() => null);
          const size = stats?.size;

          // Dedupe recent identical exports (leaked watchers / repeated events).
          const dedupeKey = `${item.id}|${size || 0}`;
          const now = Date.now();
          const lastUpload = recentDerivedUploads.get(dedupeKey);
          const DEDUPE_WINDOW_MS = 5000;
          if (lastUpload && now - lastUpload < DEDUPE_WINDOW_MS) return;
          recentDerivedUploads.set(dedupeKey, now);

          send({ state: 'started', fileName: name, size, originalId: String(item.id) });
          await uploadDerivedFile(base, String(item.id), derivedPath, name);
          send({ state: 'completed', fileName: name, size, originalId: String(item.id) });
        } catch (err) {
          send({
            state: 'error',
            fileName: name,
            originalId: String(item.id),
            error: err && err.message ? err.message : 'Failed to upload derived file',
          });
        } finally {
          derivedUploadsInProgress.delete(key);
        }
      }, DEBOUNCE_MS);

      derivedDebounceTimers.set(key, timer);
    });
    dirWatcher.on('error', () => registry.closeWatcherSafely(dirWatcher));
  } catch {
    dirWatcher = null;
  }
  return dirWatcher;
}

// Watch the edited file itself and re-upload (replace) when its hash changes,
// throttled so a burst of saves doesn't spam the backend.
function startMainFileWatcher(registry, { filePath, base, item }, initialHash) {
  let lastHash = initialHash;
  let lastUploadTime = 0;
  let uploadInProgress = false;
  const THROTTLE_MS = 5000;

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
      /* backend/logs capture upload errors */
    } finally {
      uploadInProgress = false;
    }
  }

  let watcher;
  try {
    watcher = fs.watch(filePath, () => void uploadIfChangedThrottled());
    watcher.on('error', () => registry.closeWatcherSafely(watcher));
  } catch {
    watcher = null;
  }
  return watcher;
}

function registerEditWithDesktopHandler(registry) {
  ipcMain.handle('files:editWithDesktop', async (_event, payload) => {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Desktop editing is only supported on Windows' };
    }

    try {
      const origin = validateOrigin(payload?.origin);
      const item = payload?.item;
      if (!origin || !item || !item.id || !item.name) {
        return { ok: false, error: 'Invalid payload' };
      }

      const base = origin;
      const win = BrowserWindow.fromWebContents(_event.sender);
      const fileId = String(item.id);
      const downloadUrl = `${base}/api/files/${encodeURIComponent(fileId)}/download`;

      let editDir;
      let filePath;
      try {
        ({ editDir, filePath } = await resolveEditFile(registry, base, item, downloadUrl));
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : 'Failed to download file' };
      }

      // Drop any watchers left from a previous edit session for this file.
      registry.closeWatchersForFile(fileId);

      const originalBaseName = path.basename(filePath);
      let initialHash = null;
      try {
        initialHash = await hashFile(filePath);
      } catch {
        initialHash = null;
      }

      const watcher = startMainFileWatcher(registry, { filePath, base, item }, initialHash);
      const dirWatcher = startDerivedWatcher(registry, { editDir, originalBaseName, base, item, win });
      registry.activeWatchers.set(fileId, { watcher, dirWatcher, editDir });

      try {
        const errorMessage = await shell.openPath(filePath);
        if (errorMessage) return { ok: false, error: errorMessage };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : 'Failed to open file with default application' };
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Unexpected error' };
    }
  });
}

module.exports = { registerEditWithDesktopHandler };
