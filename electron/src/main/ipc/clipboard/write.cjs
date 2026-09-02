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
} = require('../../utils/file-utils.cjs');
const { readFilesFromClipboard, peekClipboardFileNames } = require('./read.cjs');

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
      cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);
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
      cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);

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
