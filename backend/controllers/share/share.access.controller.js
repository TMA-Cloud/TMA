const { validateAndResolveFile } = require('../../utils/fileDownload');
const { sendError } = require('../../utils/response');
const { getFileByToken, getFolderContentsByShare } = require('../../models/share.model');
const { validateToken } = require('../../utils/validation');
const { logger } = require('../../config/logger');
const { shareAccessed } = require('../../services/auditLogger');
const { escapeHtml } = require('./share.utils');

/**
 * Handle shared file/folder access
 * For folders: displays HTML listing
 * For files: downloads the file
 */
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

module.exports = {
  handleShared,
};
