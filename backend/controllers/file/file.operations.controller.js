import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import {
  copyFiles as copyFilesModel,
  getFileInfo,
  getTargetFolderName,
  moveFiles as moveFilesModel,
  resolveTargetFolderId,
} from '../../models/file.model.js';
import { linkNewItemsToParentShare } from '../../services/shareLinking.js';
import { userOperationLock } from '../../utils/mutex.js';
import { sendSuccess } from '../../utils/response.js';
import { logBulkFileAudit } from '../../utils/controllerHelpers.js';

async function getPasteContext(req) {
  const { ids, parentId: requestedParentId } = req.body;

  const actualParentId = await resolveTargetFolderId(requestedParentId, req.ownerId);
  const fileInfo = await getFileInfo(ids, req.ownerId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  const targetFolderName = await getTargetFolderName(actualParentId, req.ownerId);

  return { ids, actualParentId, fileInfo, fileNames, fileTypes, targetFolderName };
}
/**
 * Move files or folders to a different location
 */
async function moveFilesController(req, res) {
  const { ids, actualParentId, fileInfo, fileNames, fileTypes, targetFolderName } = await getPasteContext(req);

  await userOperationLock(req.ownerId, async () => {
    await moveFilesModel(ids, actualParentId, req.ownerId);
  });

  await logBulkFileAudit(
    'file.move',
    { ids, fileNames, fileTypes, metadata: { targetParentId: actualParentId, targetFolderName } },
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
        userId: req.ownerId,
      },
    }))
  );

  await linkNewItemsToParentShare({ ownerId: req.ownerId, parentId: actualParentId, itemIds: ids });

  sendSuccess(res, { message: 'Files moved successfully.' });
}

/**
 * Copy files or folders to a different location
 */
async function copyFilesController(req, res) {
  const { ids, actualParentId, fileNames, fileTypes, targetFolderName } = await getPasteContext(req);

  const newFileIds = await userOperationLock(req.ownerId, async () => {
    return copyFilesModel(ids, actualParentId, req.ownerId);
  });

  await logBulkFileAudit(
    'file.copy',
    { ids, fileNames, fileTypes, metadata: { targetParentId: actualParentId, targetFolderName } },
    req
  );
  logger.info({ fileIds: ids, fileNames, targetFolderName }, 'Files copied');

  // Fetch the newly-created copies by their exact IDs (returned by the model)
  // instead of guessing via name+type which is racy with concurrent operations.
  const newFilesResult = await pool.query(
    'SELECT id, name, type FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
    [newFileIds, req.ownerId]
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
        userId: req.ownerId,
      },
    }))
  );

  await linkNewItemsToParentShare({ ownerId: req.ownerId, parentId: actualParentId, itemIds: newFileIds });

  sendSuccess(res, { message: 'Files copied successfully.' });
}

const moveFiles = moveFilesController;
const copyFiles = copyFilesController;

export { moveFiles, copyFiles };
