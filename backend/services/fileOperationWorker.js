import { cleanupExpiredTrash } from '../models/file/file.cleanup.model.js';
import { getFileInfo } from '../models/file/file.info.model.js';
import { copyFiles } from '../models/file/file.operations.model.js';
import { deleteFiles, permanentlyDeleteFiles, restoreFiles } from '../models/file/file.trash.model.js';
import { FILE_OPERATION_QUEUE } from './backgroundQueue.js';
import { EventTypes, publishFileEventsBatch } from './fileEvents.js';
import { linkNewItemsToParentShare } from './shareLinking.js';

/** Execute a durable file mutation. Every task is safe to retry. */
async function processFileOperation(job, { boss = null } = {}) {
  const { task, ids = [], userId, parentId = null, targetFolderName = 'Root' } = job.data || {};
  if (task === 'continue-trash-cleanup') {
    const result = await cleanupExpiredTrash();
    if (result.hasMore && boss) {
      await boss.send(FILE_OPERATION_QUEUE, { task }, { startAfter: 60 });
    }
    return result;
  }
  if (!userId) throw new Error('Missing file-operation userId');
  if (task === 'copy') {
    const newFileIds = await copyFiles(ids, parentId, userId, { operationId: job.id });
    const copiedFiles = await getFileInfo(newFileIds, userId);
    await linkNewItemsToParentShare({ ownerId: userId, parentId, itemIds: newFileIds });
    await publishFileEventsBatch(
      copiedFiles.map(file => ({
        eventType: EventTypes.FILE_COPIED,
        eventData: {
          id: file.id,
          name: file.name,
          type: file.type,
          parentId,
          targetFolderName,
          userId,
        },
      }))
    );
    return { count: newFileIds.length, ids: newFileIds };
  }

  let count;
  let eventType;
  if (task === 'trash') {
    count = await deleteFiles(ids, userId);
    eventType = EventTypes.FILE_DELETED;
  } else if (task === 'restore') {
    count = await restoreFiles(ids, userId);
    eventType = EventTypes.FILE_RESTORED;
  } else if (task === 'delete-permanently') {
    count = await permanentlyDeleteFiles(ids, userId);
    eventType = EventTypes.FILE_PERMANENTLY_DELETED;
  } else if (task === 'empty-trash') {
    count = await permanentlyDeleteFiles([], userId, { allTrash: true });
    eventType = EventTypes.FILE_PERMANENTLY_DELETED;
  } else {
    throw new Error(`Unknown file operation: ${task}`);
  }
  await publishFileEventsBatch([
    {
      eventType,
      userId,
      eventData: { userId, action: task, count: count || 0 },
    },
  ]);
  return { count: count || 0 };
}

export { processFileOperation };
