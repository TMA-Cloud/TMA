const { sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const {
  moveFiles,
  copyFiles,
  getFileInfo,
  getTargetFolderName,
  resolveTargetFolderId,
} = require('../../models/file.model');
const pool = require('../../config/db');
const { userOperationLock } = require('../../utils/mutex');
const { publishFileEventsBatch, EventTypes } = require('../../services/fileEvents');

async function getPasteContext(req) {
  const { ids, parentId: requestedParentId } = req.body;

  const actualParentId = await resolveTargetFolderId(requestedParentId, req.userId);
  const fileInfo = await getFileInfo(ids, req.userId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  const targetFolderName = await getTargetFolderName(actualParentId, req.userId);

  return { ids, actualParentId, fileInfo, fileNames, fileTypes, targetFolderName };
}
/**
 * Move files or folders to a different location
 */
async function moveFilesController(req, res) {
  const { ids, actualParentId, fileInfo, fileNames, fileTypes, targetFolderName } = await getPasteContext(req);

  await userOperationLock(req.userId, async () => {
    await moveFiles(ids, actualParentId, req.userId);
  });

  await logAuditEvent(
    'file.move',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: ids[0],
      metadata: {
        fileCount: ids.length,
        fileIds: ids,
        fileNames,
        fileTypes,
        targetParentId: actualParentId,
        targetFolderName,
      },
    },
    req
  );
  logger.info({ fileIds: ids, fileNames, targetFolderName }, 'Files moved');

  await publishFileEventsBatch(
    fileInfo.map(file => ({
      eventType: EventTypes.FILE_MOVED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: actualParentId,
        targetFolderName,
        userId: req.userId,
      },
    }))
  );

  sendSuccess(res, { message: 'Files moved successfully.' });
}

/**
 * Copy files or folders to a different location
 */
async function copyFilesController(req, res) {
  const { ids, actualParentId, fileNames, fileTypes, targetFolderName } = await getPasteContext(req);

  await userOperationLock(req.userId, async () => {
    await copyFiles(ids, actualParentId, req.userId);
  });

  await logAuditEvent(
    'file.copy',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: ids[0],
      metadata: {
        fileCount: ids.length,
        fileIds: ids,
        fileNames,
        fileTypes,
        targetParentId: actualParentId,
        targetFolderName,
      },
    },
    req
  );
  logger.info({ fileIds: ids, fileNames, targetFolderName }, 'Files copied');

  const newFilesResult = await pool.query(
    'SELECT id, name, type FROM files WHERE name = ANY($1) AND type = ANY($2) AND parent_id = $3 AND user_id = $4 ORDER BY modified DESC LIMIT $5',
    [fileNames, fileTypes, actualParentId, req.userId, ids.length]
  );

  await publishFileEventsBatch(
    newFilesResult.rows.map(file => ({
      eventType: EventTypes.FILE_COPIED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: actualParentId,
        targetFolderName,
        userId: req.userId,
      },
    }))
  );

  sendSuccess(res, { message: 'Files copied successfully.' });
}

module.exports = {
  moveFiles: moveFilesController,
  copyFiles: copyFilesController,
};
