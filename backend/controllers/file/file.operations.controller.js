import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import {
  copyFiles as copyFilesModel,
  getFileInfo,
  getTargetFolderName,
  moveFiles as moveFilesModel,
  resolveTargetFolderId,
} from '../../models/file.model.js';
import { userOperationLock } from '../../utils/mutex.js';
import { sendSuccess } from '../../utils/response.js';

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
    await moveFilesModel(ids, actualParentId, req.userId);
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
    await copyFilesModel(ids, actualParentId, req.userId);
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

const moveFiles = moveFilesController;
const copyFiles = copyFilesController;

export { moveFiles, copyFiles };
