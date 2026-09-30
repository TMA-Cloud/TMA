/*
 * IPC clipboard handlers. Reads expose clipboard files to the renderer; writes
 * stage files under a paste temp dir and set them as the OS file-drop list so a
 * later Explorer paste drops real files.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain, BrowserWindow } = require('electron');
const {
  PASTE_DIR_PREFIX,
  sanitizeFileName,
  deduplicateFileName,
  setClipboardToPaths,
  downloadToFile,
  makeIpcProgressEmitter,
  precheckUploads,
  validateOrigin,
  cleanTempDirsByPrefix,
  uploadNewFile,
  uploadNewFileData,
} = require('../../utils/file-utils.cjs');
const { readFilesFromClipboard, peekClipboardFileNames, readClipboardFilePaths } = require('./read.cjs');

/** Virtual OLE content is held whole in memory, so the batch needs a RAM ceiling. */
const MAX_VIRTUAL_BATCH_BYTES = 500 * 1024 * 1024;
/** Stays under Chromium's six-connections-per-host ceiling. */
const SERVER_COPY_CONCURRENCY = 4;

/**
 * No XHR here for the renderer to draw a progress card from, so these two
 * channels stand in: `uploadStatus` opens and closes the card, `uploadProgress`
 * carries bytes — the same split as files:saveProgress for downloads.
 */
const sendUploadStatus = (win, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send('clipboard:uploadStatus', payload);
};
const makeUploadProgressEmitter = (win, uploadId) => makeIpcProgressEmitter(win, 'clipboard:uploadProgress', uploadId);

/**
 * One file, wrapped in the card the renderer draws. Cancels and failures come
 * back as outcomes, not throws — one bad file must not stop the rest.
 */
async function runClipboardUpload({ win, cancels, uploadId, fileName, fileSize }, upload) {
  const controller = new AbortController();
  cancels.set(uploadId, controller);
  sendUploadStatus(win, { state: 'started', id: uploadId, fileName, fileSize });
  try {
    await upload({ signal: controller.signal, onProgress: makeUploadProgressEmitter(win, uploadId) });
    sendUploadStatus(win, { state: 'completed', id: uploadId, fileName });
    return { saved: true };
  } catch (error) {
    // A cancel already took the card away; say nothing more about it.
    if (error?.aborted) return { cancelled: true };
    const reason = error?.message || 'Clipboard upload failed';
    sendUploadStatus(win, { state: 'error', id: uploadId, fileName, error: reason });
    return { failure: { fileName, reason } };
  } finally {
    cancels.delete(uploadId);
  }
}

function registerClipboardHandlers() {
  /** In-flight clipboard uploads by upload id, so the renderer's Cancel can abort one. */
  const cancels = new Map();

  ipcMain.handle('clipboard:cancelUpload', (_event, uploadId) => {
    const controller = typeof uploadId === 'string' ? cancels.get(uploadId) : null;
    if (!controller) return { ok: false };
    controller.abort();
    return { ok: true };
  });

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
  ipcMain.handle('clipboard:uploadFiles', async (event, payload) => {
    const origin = validateOrigin(payload?.origin);
    if (process.platform !== 'win32' || !origin) return { ok: false, error: 'Invalid request' };
    const paths = await readClipboardFilePaths();
    if (paths.length === 0) return { ok: false, fallback: true };
    const sizes = [];
    for (const filePath of paths) {
      sizes.push((await fs.promises.stat(filePath)).size);
    }
    try {
      await precheckUploads(
        origin,
        paths.map((filePath, i) => ({ name: path.basename(filePath), size: sizes[i] }))
      );
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const batchId = `clipboard-${Date.now()}`;
    const uploaded = [];
    const failed = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(3, paths.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= paths.length) return;
        const filePath = paths[index];
        const fileName = path.basename(filePath);
        const result = await runClipboardUpload(
          { win, cancels, uploadId: `${batchId}-${index}`, fileName, fileSize: sizes[index] },
          options => uploadNewFile(origin, payload.parentId || null, filePath, fileName, options)
        );
        if (result.saved) uploaded.push(fileName);
        else if (result.failure) failed.push(result.failure);
      }
    });
    await Promise.all(workers);
    // A refused file is an outcome, not a failed paste: `ok` stays true and the
    // reasons go to the renderer's upload-issues dialog.
    sendUploadStatus(win, { state: 'finished', batchId, saved: uploaded.length, failed });
    return { ok: true, names: uploaded, failed };
  });

  // Virtual OLE clipboard files have no filesystem path. Extract them in the
  // main process and upload from memory so plaintext upload data never touches
  // the host temp directory or crosses renderer IPC.
  ipcMain.handle('clipboard:uploadVirtualFiles', async (event, payload) => {
    const origin = validateOrigin(payload?.origin);
    if (process.platform !== 'win32' || !origin) return { ok: false, error: 'Invalid request' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const batchId = `clipboard-virtual-${Date.now()}`;
    let fileIndex = 0;
    const uploaded = [];
    const failed = [];
    // Close out the cards started so far, whatever ends the run.
    const finish = () => sendUploadStatus(win, { state: 'finished', batchId, saved: uploaded.length, failed });
    try {
      const all = await readFilesFromClipboard();
      if (all.length === 0) return { ok: false, empty: true };
      const files = all.filter(file => file?.name && typeof file.data === 'string');
      // base64 decodes to ~3/4 of its length: close enough, and it saves
      // decoding every file up front.
      const sizes = files.map(file => Math.floor((file.data.length * 3) / 4));
      if (sizes.reduce((sum, size) => sum + size, 0) > MAX_VIRTUAL_BATCH_BYTES) {
        return { ok: false, error: 'Pasted clipboard content is too large to upload from memory' };
      }
      try {
        await precheckUploads(
          origin,
          files.map((file, i) => ({ name: file.name, size: sizes[i] }))
        );
      } catch (error) {
        return { ok: false, error: error.message };
      }
      for (const file of files) {
        const data = Buffer.from(file.data, 'base64');
        const result = await runClipboardUpload(
          { win, cancels, uploadId: `${batchId}-${fileIndex++}`, fileName: file.name, fileSize: data.length },
          options => uploadNewFileData(origin, payload.parentId || null, data, file.name, options)
        );
        if (result.saved) uploaded.push(file.name);
        else if (result.failure) failed.push(result.failure);
      }
      if (uploaded.length === 0 && failed.length === 0) return { ok: false, empty: true };
      finish();
      return { ok: true, names: uploaded, failed };
    } catch (error) {
      finish();
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
        // Async: a sync write of up to 200 MB would freeze every window meanwhile.
        await fs.promises.writeFile(filePath, buf);
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

      // Names are settled up front so deduplication stays deterministic.
      const seen = new Set();
      const jobs = [];
      for (const item of payload.items) {
        if (!item || !item.id || !item.name) continue;
        const baseName = deduplicateFileName(sanitizeFileName(String(item.name)), seen);
        seen.add(baseName);
        jobs.push({
          filePath: path.join(pasteDir, baseName),
          downloadUrl: `${base}/api/files/${encodeURIComponent(String(item.id))}/download`,
        });
      }

      // A few downloads at once; one at a time made copying many small files crawl.
      const done = new Array(jobs.length).fill(false);
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const index = next++;
          const { filePath, downloadUrl } = jobs[index];
          try {
            await downloadToFile(downloadUrl, filePath);
            done[index] = true;
          } catch (_) {
            await fs.promises.rm(filePath, { force: true }).catch(() => {});
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SERVER_COPY_CONCURRENCY, jobs.length) }, worker));
      const writtenPaths = jobs.filter((_, i) => done[i]).map(job => job.filePath);

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
