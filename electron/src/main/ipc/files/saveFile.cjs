/*
 * files:saveFile / files:saveFilesBulk — prompt for a destination and stream a
 * single file (or a bulk zip) from the backend to the chosen path.
 */
const { ipcMain, dialog, BrowserWindow } = require('electron');
const { sanitizeFileName, downloadToFile, downloadPostToFile, validateOrigin } = require('../../utils/file-utils.cjs');

const SAVE_DIALOG_TITLE = 'TMA Cloud';

function registerSaveFileHandlers() {
  ipcMain.handle('files:saveFile', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: 'No window' };

    const origin = validateOrigin(payload?.origin);
    const fileId = payload?.fileId;
    const suggestedFileName = typeof payload?.suggestedFileName === 'string' ? payload.suggestedFileName : 'download';
    if (!origin || !fileId) return { ok: false, error: 'Invalid payload' };

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: SAVE_DIALOG_TITLE,
      defaultPath: sanitizeFileName(suggestedFileName),
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const downloadUrl = `${origin}/api/files/${encodeURIComponent(String(fileId))}/download`;
    try {
      await downloadToFile(downloadUrl, filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Failed to download file' };
    }
  });

  ipcMain.handle('files:saveFilesBulk', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: 'No window' };

    const origin = validateOrigin(payload?.origin);
    const ids = Array.isArray(payload?.ids) ? payload.ids.filter(id => id != null) : [];
    if (!origin || ids.length === 0) return { ok: false, error: 'Invalid payload' };

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: SAVE_DIALOG_TITLE,
      defaultPath: `download_${Date.now()}.zip`,
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const bulkUrl = `${origin}/api/files/download/bulk`;
    try {
      await downloadPostToFile(bulkUrl, { ids }, filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Failed to download files' };
    }
  });
}

module.exports = { registerSaveFileHandlers };
