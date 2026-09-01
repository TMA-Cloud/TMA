import { logger } from '../../config/logger.js';
import { getFileByToken, getFolderContentsByShare } from '../../models/share.model.js';
import { recordAccess } from '../../services/accessTracker.js';
import { shareAccessed } from '../../services/auditLogger.js';
import { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile } from '../../utils/fileDownload.js';
import { sendError } from '../../utils/response.js';

import { escapeHtml, renderErrorPage } from './share.utils.js';

/**
 * Handle shared file/folder access
 * For folders: displays HTML listing
 * For files: downloads the file
 */
async function handleShared(req, res) {
  try {
    const { token } = req.params;
    const file = await getFileByToken(token);

    if (!file) {
      return renderErrorPage(res, 404, 'Link not found', 'This share link does not exist or has been removed.');
    }
    if (file.expired) {
      return renderErrorPage(res, 410, 'Link expired', 'This share link has expired and is no longer available.');
    }

    // Log share access (anonymous users)
    await shareAccessed(token, req);

    // A visitor on a share link is still a reader, so the item counts as
    // accessed on the owner's account. Who did the reading stays in the audit
    // trail; this timestamp only records that it happened.
    recordAccess(file.id, file.userId);
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
      const { success, storageKey, ciphertextSize, isEncrypted, error } = await validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }

      // If file is encrypted, stream decrypted content (Range-aware)
      if (isEncrypted) {
        return streamEncryptedFile(res, storageKey, file.name, file.mime_type || 'application/octet-stream', {
          req,
          ciphertextSize,
        });
      }

      // For unencrypted files, use streaming
      return streamUnencryptedFile(res, storageKey, file.name, file.mime_type || 'application/octet-stream', true);
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

export { handleShared };
