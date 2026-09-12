import { logger } from '../../config/logger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import {
  getFileInfo,
  getTargetFolderName,
  moveFiles as moveFilesModel,
  resolveTargetFolderId,
} from '../../models/file.model.js';
import { getBoss } from '../../services/auditLogger/queue.js';
import { ACCOUNT_FILE_OPERATION_QUEUE } from '../../services/backgroundQueue.js';
import { linkNewItemsToParentShare } from '../../services/shareLinking.js';
import { userOperationLock } from '../../utils/mutex.js';
import { sendError, sendSuccess } from '../../utils/response.js';
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
  const boss = getBoss();
  if (!boss) return sendError(res, 503, 'Background worker queue is unavailable');

  // Copying a tree can require many server-side multipart object copies. The
  // request only needs a durable handoff; the worker reports completion through
  // the job-status endpoint and emits the normal file event afterwards.
  const jobId = await boss.send(
    ACCOUNT_FILE_OPERATION_QUEUE,
    {
      task: 'copy',
      ids,
      userId: req.ownerId,
      parentId: actualParentId,
      targetFolderName,
    },
    { singletonKey: req.ownerId }
  );

  await logBulkFileAudit(
    'file.copy.queued',
    { ids, fileNames, fileTypes, metadata: { targetParentId: actualParentId, targetFolderName, jobId } },
    req
  );
  logger.info({ fileIds: ids, fileNames, targetFolderName, jobId }, 'File copy queued');
  sendSuccess(res, { message: 'Copy queued.', queued: true, jobId }, 202);
}

const moveFiles = moveFilesController;
const copyFiles = copyFilesController;

export { moveFiles, copyFiles };
