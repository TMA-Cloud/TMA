const { validateAndResolveFile } = require('../utils/fileDownload');
const { sendError } = require('../utils/response');
const { createZipArchive } = require('../utils/zipArchive');
const { getFileByToken, getFolderContentsByShare, isFileShared, getSharedTree } = require('../models/share.model');
const pool = require('../config/db');
const { validateToken, validateId } = require('../utils/validation');
const { logger } = require('../config/logger');
const { shareAccessed } = require('../services/auditLogger');

// HTML escaping function to prevent XSS
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

async function handleShared(req, res) {
  try {
    const token = validateToken(req.params.token);
    if (!token) {
      return res.status(400).send('Invalid share token');
    }
    const file = await getFileByToken(token);
    if (!file) return res.status(404).send('Not found');

    // Log share access (anonymous users)
    await shareAccessed(token, req);
    logger.info({ shareToken: token, fileId: file.id, fileType: file.type }, 'Share link accessed');

    if (file.type === 'folder') {
      const items = await getFolderContentsByShare(token, file.id);
      const escapedFileName = escapeHtml(file.name);
      const escapedToken = escapeHtml(token);
      let html = `<html><head><title>${escapedFileName}</title><style>body{font-family:sans-serif;padding:20px;}a{color:#0366d6;text-decoration:none;}li{margin-bottom:8px;}</style></head><body>`;
      html += `<h2>${escapedFileName}</h2>`;
      html += `<ul>`;
      for (const item of items) {
        const escapedItemName = escapeHtml(item.name);
        const escapedItemId = escapeHtml(item.id);
        html += `<li>${item.type === 'folder' ? '📁' : '📄'} ${escapedItemName} - <a href="/s/${escapedToken}/file/${escapedItemId}">Download</a></li>`;
      }
      html += `</ul>`;
      html += `<p><a href="/s/${escapedToken}/zip">Download All as ZIP</a></p>`;
      html += `</body></html>`;
      res.send(html);
    } else {
      const { success, filePath, error } = validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }
      res.download(filePath, file.name, err => {
        if (err) logger.error({ err }, 'Error sending file');
      });
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function downloadFolderZip(req, res) {
  try {
    const token = validateToken(req.params.token);
    if (!token) {
      return res.status(400).send('Invalid share token');
    }
    const file = await getFileByToken(token);
    if (!file || file.type !== 'folder') return res.status(404).send('Not found');

    // Log share download (ZIP)
    const { logAuditEvent } = require('../services/auditLogger');
    await logAuditEvent(
      'share.download',
      {
        status: 'success',
        resourceType: 'share',
        resourceId: token,
        metadata: { fileName: file.name, downloadType: 'zip' },
      },
      req
    );
    logger.info({ shareToken: token, folderId: file.id }, 'Share folder downloaded as ZIP');

    const entries = await getSharedTree(token, file.id);
    createZipArchive(res, file.name, entries, file.id, file.name);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function downloadSharedItem(req, res) {
  try {
    const token = validateToken(req.params.token);
    if (!token) {
      return res.status(400).send('Invalid share token');
    }
    const fileId = validateId(req.params.id);
    if (!fileId) {
      return res.status(400).send('Invalid file ID');
    }
    const allowed = await isFileShared(token, fileId);
    if (!allowed) return res.status(404).send('Not found');
    const res2 = await pool.query('SELECT id, name, type, mime_type AS "mimeType", path FROM files WHERE id = $1', [
      fileId,
    ]);
    const file = res2.rows[0];
    if (!file) return res.status(404).send('Not found');

    // Log share item download
    const { logAuditEvent } = require('../services/auditLogger');
    await logAuditEvent(
      'share.download',
      {
        status: 'success',
        resourceType: 'share',
        resourceId: token,
        metadata: { fileName: file.name, fileId, fileType: file.type },
      },
      req
    );
    logger.info({ shareToken: token, fileId, fileType: file.type }, 'Share item downloaded');

    if (file.type === 'file') {
      const { success, filePath, error } = validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }
      return res.download(filePath, file.name, err => {
        if (err) logger.error({ err }, 'Error sending file');
      });
    }
    // folder: create zip of shared contents under this folder
    const entries = await getSharedTree(token, fileId);
    createZipArchive(res, file.name, entries, file.id, file.name);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  handleShared,
  downloadFolderZip,
  downloadSharedItem,
};
