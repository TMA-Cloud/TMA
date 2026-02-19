const { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile } = require('../../utils/fileDownload');
const { sendError } = require('../../utils/response');
const { createZipArchive } = require('../../utils/zipArchive');
const { getFileByToken, isFileShared, getSharedTree } = require('../../models/share.model');
const pool = require('../../config/db');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { renderErrorPage } = require('./share.utils');

/**
 * Download shared folder as ZIP
 */
async function downloadFolderZip(req, res) {
  try {
    const { token } = req.params;
    const file = await getFileByToken(token);

    if (!file) {
      return renderErrorPage(res, 404, 'Link not found', 'This share link does not exist or has been removed.');
    }
    if (file.expired) {
      return renderErrorPage(res, 410, 'Link expired', 'This share link has expired and is no longer available.');
    }
    if (file.type !== 'folder') {
      return renderErrorPage(res, 404, 'Not found', 'The requested resource was not found.');
    }

    // Log share download (ZIP)
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
    await createZipArchive(res, file.name, entries, file.id, file.name);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Download a specific shared item (file or folder as ZIP)
 */
async function downloadSharedItem(req, res) {
  try {
    const { token, id: fileId } = req.params;

    // Check link-level expiry first
    const shareFile = await getFileByToken(token);
    if (!shareFile) {
      return renderErrorPage(res, 404, 'Link not found', 'This share link does not exist or has been removed.');
    }
    if (shareFile.expired) {
      return renderErrorPage(res, 410, 'Link expired', 'This share link has expired and is no longer available.');
    }

    const allowed = await isFileShared(token, fileId);
    if (!allowed) {
      return renderErrorPage(res, 404, 'Not found', 'The requested file was not found in this share.');
    }

    // Strict DB permission: only return file if it belongs to this share (defense-in-depth)
    const res2 = await pool.query(
      `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.path
       FROM files f
       INNER JOIN share_link_files slf ON slf.file_id = f.id AND slf.share_id = $1
       WHERE f.id = $2`,
      [token, fileId]
    );
    const file = res2.rows[0];
    if (!file) {
      return renderErrorPage(res, 404, 'Not found', 'The requested file was not found in this share.');
    }

    // Log share item download
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
      const { success, filePath, storageKey, isEncrypted, error } = await validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }
      const pathOrKey = filePath || storageKey;

      // If file is encrypted, stream decrypted content
      if (isEncrypted) {
        return streamEncryptedFile(res, pathOrKey, file.name, file.mimeType || 'application/octet-stream');
      }

      // For unencrypted files, use streaming
      return streamUnencryptedFile(res, pathOrKey, file.name, file.mimeType || 'application/octet-stream', true);
    }
    // folder: create zip of shared contents under this folder
    const entries = await getSharedTree(token, fileId);
    await createZipArchive(res, file.name, entries, file.id, file.name);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  downloadFolderZip,
  downloadSharedItem,
};
