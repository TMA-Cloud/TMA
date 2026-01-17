const { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile } = require('../../utils/fileDownload');
const { isAgentOfflineError } = require('../../utils/agentErrorDetection');
const { AGENT_OFFLINE_MESSAGE, AGENT_OFFLINE_STATUS } = require('../../utils/agentConstants');
const { sendError } = require('../../utils/response');
const { createZipArchive } = require('../../utils/zipArchive');
const { getFileByToken, isFileShared, getSharedTree } = require('../../models/share.model');
const pool = require('../../config/db');
const { validateToken } = require('../../utils/validation');
const { validateSingleId } = require('../../utils/controllerHelpers');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');

/**
 * Download shared folder as ZIP
 */
async function downloadFolderZip(req, res) {
  try {
    const token = validateToken(req.params.token);
    if (!token) {
      return res.status(400).send('Invalid share token');
    }
    const file = await getFileByToken(token);
    if (!file || file.type !== 'folder') return res.status(404).send('Not found');

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
    try {
      await createZipArchive(res, file.name, entries, file.id, file.name);
    } catch (err) {
      // Check if error is agent-related
      if (isAgentOfflineError(err)) {
        return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
      }
      throw err;
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Download a specific shared item (file or folder as ZIP)
 */
async function downloadSharedItem(req, res) {
  try {
    const token = validateToken(req.params.token);
    if (!token) {
      return res.status(400).send('Invalid share token');
    }
    const { valid, id: fileId, error } = validateSingleId(req);
    if (!valid) {
      return res.status(400).send(error);
    }
    const allowed = await isFileShared(token, fileId);
    if (!allowed) return res.status(404).send('Not found');
    const res2 = await pool.query('SELECT id, name, type, mime_type AS "mimeType", path FROM files WHERE id = $1', [
      fileId,
    ]);
    const file = res2.rows[0];
    if (!file) return res.status(404).send('Not found');

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
      const { success, filePath, isEncrypted, error } = await validateAndResolveFile(file);
      if (!success) {
        return res.status(400).send(error || 'Invalid file path');
      }

      // If file is encrypted, stream decrypted content
      if (isEncrypted) {
        return streamEncryptedFile(res, filePath, file.name, file.mimeType || 'application/octet-stream');
      }

      // For unencrypted files, use streaming
      return streamUnencryptedFile(res, filePath, file.name, file.mimeType || 'application/octet-stream', true);
    }
    // folder: create zip of shared contents under this folder
    const entries = await getSharedTree(token, fileId);
    try {
      await createZipArchive(res, file.name, entries, file.id, file.name);
    } catch (err) {
      // Check if error is agent-related
      if (isAgentOfflineError(err)) {
        return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
      }
      throw err;
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  downloadFolderZip,
  downloadSharedItem,
};
