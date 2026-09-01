import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { getFileByToken, getSharedTree } from '../../models/share.model.js';
import { recordAccess } from '../../services/accessTracker.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile } from '../../utils/fileDownload.js';
import { sendError } from '../../utils/response.js';
import { createZipArchive } from '../../utils/zipArchive.js';

import { renderErrorPage } from './share.utils.js';

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

    // Everything the archive pulls in was read. All shared rows belong to the
    // link's owner, and the writer matches on user_id, so anything that somehow
    // does not simply fails to match and is skipped.
    recordAccess([file.id, ...entries.map(entry => entry.id)], file.userId);

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

    // Single atomic check: only return the file if it belongs to this share.
    // This replaces a prior two-step check (isFileShared + INNER JOIN) that
    // was susceptible to a TOCTOU race if the share was modified between calls.
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
      const { success, storageKey, ciphertextSize, isEncrypted, error } = await validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }

      recordAccess(file.id, shareFile.userId);

      // If file is encrypted, stream decrypted content (Range-aware)
      if (isEncrypted) {
        return streamEncryptedFile(res, storageKey, file.name, file.mimeType || 'application/octet-stream', {
          req,
          ciphertextSize,
        });
      }

      // For unencrypted files, use streaming
      return streamUnencryptedFile(res, storageKey, file.name, file.mimeType || 'application/octet-stream', true);
    }
    // folder: create zip of shared contents under this folder
    const entries = await getSharedTree(token, fileId);
    recordAccess([file.id, ...entries.map(entry => entry.id)], shareFile.userId);
    await createZipArchive(res, file.name, entries, file.id, file.name);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

export { downloadFolderZip, downloadSharedItem };
