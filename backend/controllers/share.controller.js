const path = require('path');
const archiver = require('archiver');
const { resolveFilePath, isValidPath } = require('../utils/filePath');
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
      if (!isValidPath(file.path)) {
        return res.status(400).send('Invalid file path');
      }
      let filePath;
      try {
        filePath = resolveFilePath(file.path);
      } catch (err) {
        return res.status(400).send('Invalid file path');
      }
      res.download(filePath, file.name, err => { if (err) console.error(err); });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
}

async function downloadFolderZip(req, res) {
  try {
    const file = await getFileByToken(req.params.token);
    if (!file || file.type !== 'folder') return res.status(404).send('Not found');
    const entries = await getSharedTree(req.params.token, file.id);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}.zip"`);
    const archive = archiver('zip');
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    const addEntry = (id, base) => {
      for (const entry of entries.filter(e => e.parent_id === id)) {
        const relPath = base ? path.join(base, entry.name) : entry.name;
        if (entry.type === 'file' && isValidPath(entry.path)) {
          try {
            const p = resolveFilePath(entry.path);
            archive.file(p, { name: relPath });
          } catch (err) {
            console.error(`[Share] Error adding file to archive: ${entry.name}`, err);
          }
        } else if (entry.type === 'folder') {
          addEntry(entry.id, relPath);
        }
      }
    };
    addEntry(file.id, file.name);
    archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
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
      if (!isValidPath(file.path)) {
        return res.status(400).send('Invalid file path');
      }
      let filePath;
      try {
        filePath = resolveFilePath(file.path);
      } catch (err) {
        return res.status(400).send('Invalid file path');
      }
      return res.download(filePath, file.name, err => { if (err) console.error(err); });
    }
    // folder: create zip of shared contents under this folder
    const entries = await getSharedTree(token, file.id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}.zip"`);
    const archive = archiver('zip');
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    const addEntry = (id, base) => {
      for (const entry of entries.filter(e => e.parent_id === id)) {
        const relPath = base ? path.join(base, entry.name) : entry.name;
        if (entry.type === 'file' && isValidPath(entry.path)) {
          try {
            const p = resolveFilePath(entry.path);
            archive.file(p, { name: relPath });
          } catch (err) {
            console.error(`[Share] Error adding file to archive: ${entry.name}`, err);
          }
        } else if (entry.type === 'folder') {
          addEntry(entry.id, relPath);
        }
      }
    };
    addEntry(file.id, file.name);
    archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
}

module.exports = {
  handleShared,
  downloadFolderZip,
  downloadSharedItem,
};
