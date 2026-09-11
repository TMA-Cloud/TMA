/*
 * IPC clipboard handlers. Reads expose clipboard files to the renderer; writes
 * stage files under a paste temp dir and set them as the OS file-drop list so a
 * later Explorer paste drops real files.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain } = require('electron');
const {
  PASTE_DIR_PREFIX,
  sanitizeFileName,
  deduplicateFileName,
  setClipboardToPaths,
  downloadToFile,
  validateOrigin,
  cleanTempDirsByPrefix,
  uploadNewFile,
  uploadNewFileData,
} = require('../../utils/file-utils.cjs');
const { readFilesFromClipboard, peekClipboardFileNames, readClipboardFilePaths } = require('./read.cjs');

function registerClipboardHandlers() {
  ipcMain.handle('clipboard:peekFileNames', async () => {
    try {
      return { names: await peekClipboardFileNames() };
    } catch (_) {
      return { names: [] };
    }
  });

  ipcMain.handle('clipboard:readFiles', async () => {
    try {
      return { files: await readFilesFromClipboard() };
    } catch (_) {
      return { files: [] };
    }
  });

  // Physical clipboard files are uploaded from disk streams in the main
  // process. Their bytes never become base64 or cross IPC into the renderer.
  ipcMain.handle('clipboard:uploadFiles', async (_event, payload) => {
    const origin = validateOrigin(payload?.origin);
    if (process.platform !== 'win32' || !origin) return { ok: false, error: 'Invalid request' };
    const paths = await readClipboardFilePaths();
    if (paths.length === 0) return { ok: false, fallback: true };
    const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
    const MAX_PER_FILE_BYTES = 200 * 1024 * 1024;
    let total = 0;
    for (const filePath of paths) {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_PER_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) {
        return { ok: false, error: 'Clipboard files exceed the 500 MB total or 200 MB per-file limit' };
      }
      total += stat.size;
    }
    const uploaded = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(3, paths.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= paths.length) return;
        const filePath = paths[index];
        await uploadNewFile(origin, payload.parentId || null, filePath, path.basename(filePath));
        uploaded.push(path.basename(filePath));
      }
    });
    try {
      await Promise.all(workers);
      return { ok: true, names: uploaded };
    } catch (error) {
      return { ok: false, error: error.message || 'Clipboard upload failed' };
    }
  });

  // Virtual OLE clipboard files have no filesystem path. Extract them in the
  // main process and upload from memory so plaintext upload data never touches
  // the host temp directory or crosses renderer IPC.
  ipcMain.handle('clipboard:uploadVirtualFiles', async (_event, payload) => {
    const origin = validateOrigin(payload?.origin);
    if (process.platform !== 'win32' || !origin) return { ok: false, error: 'Invalid request' };
    try {
      const files = await readFilesFromClipboard();
      if (files.length === 0) return { ok: false, empty: true };
      const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
      const MAX_PER_FILE_BYTES = 50 * 1024 * 1024;
      let totalBytes = 0;
      const uploaded = [];
      for (const file of files) {
        if (!file?.name || typeof file.data !== 'string') continue;
        const estimatedBytes = Math.floor((file.data.length * 3) / 4);
        if (estimatedBytes > MAX_PER_FILE_BYTES || totalBytes + estimatedBytes > MAX_TOTAL_BYTES) {
          return { ok: false, error: 'Virtual clipboard files exceed the 100 MB total or 50 MB per-file limit' };
        }
        const data = Buffer.from(file.data, 'base64');
        if (data.length > MAX_PER_FILE_BYTES || totalBytes + data.length > MAX_TOTAL_BYTES) {
          return { ok: false, error: 'Virtual clipboard files exceed the allowed size' };
        }
        totalBytes += data.length;
        await uploadNewFileData(origin, payload.parentId || null, data, file.name);
        uploaded.push(file.name);
      }
      return uploaded.length > 0 ? { ok: true, names: uploaded } : { ok: false, empty: true };
    } catch (error) {
      return { ok: false, error: error.message || 'Virtual clipboard upload failed' };
    }
  });

  ipcMain.handle('clipboard:writeFiles', async (_event, paths) => {
    if (process.platform !== 'win32' || !Array.isArray(paths) || paths.length === 0) {
      return { ok: false };
    }
    try {
      await setClipboardToPaths(paths);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('clipboard:writeFilesFromData', async (_event, payload) => {
    if (process.platform !== 'win32' || !payload?.files?.length) {
      return { ok: false, error: 'Invalid payload' };
    }
    // Cap decoded size to avoid OOM from a malicious renderer sending huge base64.
    const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
    const MAX_PER_FILE_BYTES = 200 * 1024 * 1024; // 200 MB
    const tmpRoot = os.tmpdir();
    try {
      await cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);
      const pasteDir = path.join(tmpRoot, `${PASTE_DIR_PREFIX}${Date.now()}`);
      fs.mkdirSync(pasteDir, { recursive: true });
      const writtenPaths = [];
      const seen = new Set();
      let totalBytes = 0;
      for (const f of payload.files) {
        if (!f.name || typeof f.data !== 'string') continue;
        // base64 decodes to ~3/4 of its length: cheap upper bound before allocating.
        const estimatedBytes = Math.floor((f.data.length * 3) / 4);
        if (estimatedBytes > MAX_PER_FILE_BYTES) {
          return { ok: false, error: 'File exceeds maximum allowed size' };
        }
        if (totalBytes + estimatedBytes > MAX_TOTAL_BYTES) {
          return { ok: false, error: 'Total payload size exceeds maximum allowed' };
        }
        const base = deduplicateFileName(sanitizeFileName(f.name), seen);
        seen.add(base);
        const filePath = path.join(pasteDir, base);
        const buf = Buffer.from(f.data, 'base64');
        if (buf.length > MAX_PER_FILE_BYTES || totalBytes + buf.length > MAX_TOTAL_BYTES) {
          return { ok: false, error: 'File size exceeds maximum allowed' };
        }
        totalBytes += buf.length;
        fs.writeFileSync(filePath, buf);
        writtenPaths.push(filePath);
      }
      if (writtenPaths.length === 0) {
        try {
          fs.rmSync(pasteDir, { recursive: true });
        } catch (_) {
          /* ignore */
        }
        return { ok: false, error: 'No valid files' };
      }
      await setClipboardToPaths(writtenPaths);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('clipboard:writeFilesFromServer', async (_event, payload) => {
    if (process.platform !== 'win32' || !payload?.items?.length) {
      return { ok: false, error: 'Not available' };
    }

    const origin = validateOrigin(payload.origin);
    if (!origin) {
      return { ok: false, error: 'Invalid or untrusted origin' };
    }

    const base = origin;
    const tmpRoot = os.tmpdir();

    try {
      await cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);

      const pasteDir = path.join(tmpRoot, `${PASTE_DIR_PREFIX}${Date.now()}`);
      fs.mkdirSync(pasteDir, { recursive: true });

      const writtenPaths = [];
      const seen = new Set();

      for (const item of payload.items) {
        if (!item || !item.id || !item.name) continue;

        const baseName = deduplicateFileName(sanitizeFileName(String(item.name)), seen);
        seen.add(baseName);

        const filePath = path.join(pasteDir, baseName);
        const downloadUrl = `${base}/api/files/${encodeURIComponent(String(item.id))}/download`;

        try {
          await downloadToFile(downloadUrl, filePath);
          writtenPaths.push(filePath);
        } catch (_) {
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          } catch {
            /* ignore */
          }
        }
      }

      if (writtenPaths.length === 0) {
        try {
          fs.rmSync(pasteDir, { recursive: true });
        } catch (_) {
          /* ignore */
        }
        return { ok: false, error: 'Failed to download files' };
      }

      await setClipboardToPaths(writtenPaths);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { registerClipboardHandlers };
