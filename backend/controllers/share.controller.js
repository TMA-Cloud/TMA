const { validateAndResolveFile } = require('../utils/fileDownload');
const { sendError } = require('../utils/response');
const { createZipArchive } = require('../utils/zipArchive');
const {
  getFileByToken,
  getFolderContentsByShare,
  isFileShared,
  getSharedTree,
} = require('../models/share.model');
const pool = require('../config/db');

async function handleShared(req, res) {
  try {
    const file = await getFileByToken(req.params.token);
    if (!file) return res.status(404).send('Not found');
    if (file.type === 'folder') {
      const items = await getFolderContentsByShare(req.params.token, file.id);
      let html = `<html><head><title>${file.name}</title><style>body{font-family:sans-serif;padding:20px;}a{color:#0366d6;text-decoration:none;}li{margin-bottom:8px;}</style></head><body>`;
      html += `<h2>${file.name}</h2>`;
      html += `<ul>`;
      for (const item of items) {
        html += `<li>${item.type === 'folder' ? '📁' : '📄'} ${item.name} - <a href="/s/${req.params.token}/file/${item.id}">Download</a></li>`;
      }
      html += `</ul>`;
      html += `<p><a href="/s/${req.params.token}/zip">Download All as ZIP</a></p>`;
      html += `</body></html>`;
      res.send(html);
    } else {
      const { success, filePath, error } = validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }
      res.download(filePath, file.name, err => { if (err) console.error(err); });
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function downloadFolderZip(req, res) {
  try {
    const file = await getFileByToken(req.params.token);
    if (!file || file.type !== 'folder') return res.status(404).send('Not found');
    const entries = await getSharedTree(req.params.token, file.id);
    createZipArchive(res, file.name, entries, file.id, file.name);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function downloadSharedItem(req, res) {
  try {
    const token = req.params.token;
    const fileId = req.params.id;
    const allowed = await isFileShared(token, fileId);
    if (!allowed) return res.status(404).send('Not found');
    const res2 = await pool.query(
      'SELECT id, name, type, mime_type AS "mimeType", path FROM files WHERE id = $1',
      [fileId]
    );
    const file = res2.rows[0];
    if (!file) return res.status(404).send('Not found');
    if (file.type === 'file') {
      const { success, filePath, error } = validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }
      return res.download(filePath, file.name, err => { if (err) console.error(err); });
    }
    // folder: create zip of shared contents under this folder
    const entries = await getSharedTree(token, file.id);
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
