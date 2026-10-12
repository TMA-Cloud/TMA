/*
 * IPC clipboard handlers. Reads expose clipboard files to the renderer; writes
 * stage files under a paste temp dir and set them as the OS file-drop list so a
 * later Explorer paste drops real files.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain, BrowserWindow, clipboard } = require('electron');
const {
  PASTE_DIR_PREFIX,
  sanitizeFileName,
  fitFileName,
  deduplicateFileName,
  setClipboardToPaths,
  downloadToFile,
  makeIpcProgressEmitter,
  precheckUploads,
  validateOrigin,
  cleanTempDirsByPrefix,
  uploadNewFile,
  uploadNewFileData,
  collectPasteEntries,
} = require('../../utils/file-utils.cjs');
const {
  readFilesFromClipboard,
  peekClipboardFilePaths,
  readClipboardFilePaths,
  isOwnPastePath,
} = require('./read.cjs');

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

/** The web app's BULK_AGGREGATE_THRESHOLD: past this, or with folders, one card stands for the paste. */
const PER_FILE_CARD_LIMIT = 8;
/** The web app's BULK_BATCH_CONCURRENCY. */
const PASTE_UPLOAD_CONCURRENCY = 3;

/** The web app's describeBulkUpload wording: "Trip — 12 files", "2 folders — 40 files". */
function describePaste(entries) {
  const roots = new Set(entries.filter(e => e.relativePath).map(e => e.relativePath.split('/')[0]));
  const countLabel = `${entries.length.toLocaleString()} files`;
  if (roots.size === 1) return `${[...roots][0]} — ${countLabel}`;
  if (roots.size > 1) return `${roots.size} folders — ${countLabel}`;
  return countLabel;
}

/**
 * A pasted folder, or many files, under one card: combined byte progress and
 * one cancel, as a dropped folder gets in the web app. Per-file refusals are
 * collected for the issues dialog rather than stopping the batch.
 */
async function runPasteBatch({ win, cancels, uploadId, entries }, upload) {
  const controller = new AbortController();
  cancels.set(uploadId, controller);
  const label = describePaste(entries);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  sendUploadStatus(win, { state: 'started', id: uploadId, fileName: label, fileSize: total });
  const emit = makeUploadProgressEmitter(win, uploadId);
  const sent = new Array(entries.length).fill(0);
  let loaded = 0;
  const saved = [];
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < entries.length && !controller.signal.aborted) {
      const index = next++;
      const entry = entries[index];
      const onProgress = bytes => {
        loaded += bytes - sent[index];
        sent[index] = bytes;
        emit?.(loaded, total);
      };
      try {
        await upload(entry, { signal: controller.signal, onProgress });
        saved.push(entry.relativePath || path.basename(entry.filePath));
      } catch (error) {
        if (error?.aborted) return;
        // Counted as done, as the web app does, so the bar still reaches the end.
        onProgress(entry.size);
        failed.push({
          fileName: entry.relativePath || path.basename(entry.filePath),
          reason: error?.message || 'Upload failed',
        });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PASTE_UPLOAD_CONCURRENCY, entries.length) }, worker));
  } finally {
    cancels.delete(uploadId);
  }
  if (controller.signal.aborted) return { saved, failed: [] };
  sendUploadStatus(
    win,
    saved.length > 0
      ? { state: 'completed', id: uploadId, fileName: label }
      : { state: 'error', id: uploadId, fileName: label, error: failed[0]?.reason || 'Upload failed' }
  );
  return { saved, failed };
}

/** Line endings normalised, since Windows may hand text back with CRLF. */
const sameText = (a, b) => String(a ?? '').replace(/\r\n/g, '\n') === String(b ?? '').replace(/\r\n/g, '\n');

function registerClipboardHandlers() {
  /** In-flight clipboard uploads by upload id, so the renderer's Cancel can abort one. */
  const cancels = new Map();
  /** Item names this app last put on the OS clipboard; any other app's copy replaces them. */
  let claimText = null;

  // An in-app Copy or Cut takes the OS clipboard, as any Ctrl+C does, so files
  // copied in Explorer earlier can't be mistaken for newer ones at paste time.
  const claim = async names => {
    const list = (Array.isArray(names) ? names : []).filter(n => typeof n === 'string' && n.length > 0);
    if (list.length === 0) return false;
    claimText = list.join('\n');
    await clipboard.writeText(claimText);
    return true;
  };
  const stillClaimed = async () => claimText != null && sameText(await clipboard.readText(), claimText);

  ipcMain.handle('clipboard:claim', async (_event, payload) => {
    if (process.platform !== 'win32') return { ok: false };
    try {
      return { ok: await claim(payload?.names) };
    } catch (_) {
      return { ok: false };
    }
  });

  ipcMain.handle('clipboard:cancelUpload', (_event, uploadId) => {
    const controller = typeof uploadId === 'string' ? cancels.get(uploadId) : null;
    if (!controller) return { ok: false };
    controller.abort();
    return { ok: true };
  });

  // `external` means another app put files there after this app's last copy.
  ipcMain.handle('clipboard:peekFileNames', async () => {
    try {
      const paths = await peekClipboardFilePaths();
      return { names: paths.map(p => path.basename(p)), external: paths.some(p => !isOwnPastePath(p)) };
    } catch (_) {
      return { names: [], external: false };
    }
  });

  // Physical clipboard files are uploaded from disk streams in the main
  // process. Their bytes never become base64 or cross IPC into the renderer.
  ipcMain.handle('clipboard:uploadFiles', async (event, payload) => {
    const origin = validateOrigin(payload?.origin);
    if (process.platform !== 'win32' || !origin) return { ok: false, error: 'Invalid request' };
    const roots = await readClipboardFilePaths();
    if (roots.length === 0) return { ok: false, fallback: true };
    let entries;
    let skipped;
    try {
      ({ entries, skipped } = await collectPasteEntries(roots));
    } catch (error) {
      return { ok: false, error: error.message };
    }
    if (entries.length === 0 && skipped.length === 0) {
      return { ok: false, error: 'Nothing to upload: the copied folders are empty' };
    }
    try {
      await precheckUploads(
        origin,
        entries.map(entry => ({ name: path.basename(entry.filePath), size: entry.size }))
      );
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const batchId = `clipboard-${Date.now()}`;
    const parentId = payload.parentId || null;
    const upload = (entry, options) =>
      uploadNewFile(origin, parentId, entry.filePath, path.basename(entry.filePath), {
        ...options,
        relativePath: entry.relativePath || undefined,
      });
    const uploaded = [];
    const failed = [...skipped];
    if (entries.some(entry => entry.relativePath) || entries.length > PER_FILE_CARD_LIMIT) {
      const result = await runPasteBatch({ win, cancels, uploadId: `${batchId}-all`, entries }, upload);
      uploaded.push(...result.saved);
      failed.push(...result.failed);
    } else {
      let next = 0;
      const workers = Array.from({ length: Math.min(PASTE_UPLOAD_CONCURRENCY, entries.length) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= entries.length) return;
          const entry = entries[index];
          const fileName = path.basename(entry.filePath);
          const result = await runClipboardUpload(
            { win, cancels, uploadId: `${batchId}-${index}`, fileName, fileSize: entry.size },
            options => upload(entry, options)
          );
          if (result.saved) uploaded.push(fileName);
          else if (result.failure) failed.push(result.failure);
        }
      });
      await Promise.all(workers);
    }
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
      await claim(payload.items.map(item => (item?.name ? String(item.name) : '')));
      await cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);

      const pasteDir = path.join(tmpRoot, `${PASTE_DIR_PREFIX}${Date.now()}`);
      fs.mkdirSync(pasteDir, { recursive: true });

      // Names are settled up front so deduplication stays deterministic.
      const seen = new Set();
      const jobs = [];
      for (const item of payload.items) {
        if (!item || !item.id || !item.name) continue;
        const baseName = deduplicateFileName(fitFileName(pasteDir, sanitizeFileName(String(item.name)), 8), seen);
        seen.add(baseName);
        jobs.push({
          name: String(item.name),
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

      // The user copied something else while we downloaded: theirs is newer.
      if (!(await stillClaimed())) {
        await fs.promises.rm(pasteDir, { recursive: true, force: true }).catch(() => {});
        return { ok: false, superseded: true };
      }
      await setClipboardToPaths(writtenPaths);
      // Partly copied is still copied, but the toast has to say what is missing.
      return { ok: true, failed: jobs.filter((_, i) => !done[i]).map(job => job.name) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { registerClipboardHandlers };
