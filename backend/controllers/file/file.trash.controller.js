import { logger } from '../../config/logger.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import {
  deleteFiles,
  countFileTree,
  getFileInfo,
  getTrashFiles,
  permanentlyDeleteFiles,
  restoreFiles,
} from '../../models/file.model.js';
import { getBoss } from '../../services/auditLogger/queue.js';
import { FILE_OPERATION_QUEUE } from '../../services/backgroundQueue.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { validateSortBy, validateSortOrder } from '../../utils/validation.js';
import { logBulkFileAudit, wantsProgressStream, streamBulkProgress } from '../../utils/controllerHelpers.js';

const ASYNC_TREE_THRESHOLD = 1000;

async function enqueueLargeTreeOperation(task, ids, userId, count) {
  if (count <= ASYNC_TREE_THRESHOLD) return null;
  const boss = getBoss();
  if (!boss) return null;
  return boss.send(FILE_OPERATION_QUEUE, { task, ids, userId });
}

/**
 * Delete files/folders (move to trash)
 */
async function deleteFilesController(req, res) {
  const { ids } = req.body;
  const treeCount = await countFileTree(ids, req.ownerId);

  // Get file info for audit logging and events
  const fileInfo = await getFileInfo(ids, req.ownerId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  const finalize = async () => {
    // Log file deletion (soft delete to trash) with details
    await logBulkFileAudit('file.delete', { ids, fileNames, fileTypes, metadata: { permanent: false } }, req);
    return { message: 'Files moved to trash.' };
  };

  const queuedJobId = await enqueueLargeTreeOperation('trash', ids, req.ownerId, treeCount);
  if (queuedJobId) {
    await logBulkFileAudit('file.delete.queued', { ids, fileNames, fileTypes, metadata: { treeCount } }, req);
    return sendSuccess(res, { message: 'Move to trash queued.', queued: true, jobId: queuedJobId }, 202);
  }

  if (wantsProgressStream(req)) {
    return streamBulkProgress(res, { ids, processChunk: chunk => deleteFiles(chunk, req.ownerId), finalize });
  }

  await deleteFiles(ids, req.ownerId);
  sendSuccess(res, await finalize());
}

/**
 * List files in trash
 */
async function listTrash(req, res) {
  const sortBy = validateSortBy(req.query.sortBy) || 'deletedAt';
  const order = validateSortOrder(req.query.order) || 'DESC';
  // In the UI, we don't want to render every child row of a deleted folder
  // Return only top-level trashed items (hide items whose parent is also trashed)
  const result = await getTrashFiles(req.ownerId, sortBy, order, true, {
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  const files = result.files || result;
  if (result.nextCursor) res.setHeader('X-Next-Cursor', result.nextCursor);
  sendSuccess(res, files);
}

/**
 * Restore files from trash
 */
async function restoreFilesController(req, res) {
  const { ids } = req.body;
  const treeCount = await countFileTree(ids, req.ownerId, { deleted: true });

  // Get file info for audit logging and events (from trash)
  const fileInfo = await getFileInfo(ids, req.ownerId, true);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  if (fileInfo.length === 0) {
    return sendError(res, 404, 'No files found in trash to restore');
  }

  const queuedJobId = await enqueueLargeTreeOperation('restore', ids, req.ownerId, treeCount);
  if (queuedJobId) {
    await logBulkFileAudit('file.restore.queued', { ids, fileNames, fileTypes, metadata: { treeCount } }, req);
    return sendSuccess(res, { message: 'Restore queued.', queued: true, jobId: queuedJobId }, 202);
  }

  const finalize = async () => {
    // Log file restore with details
    await logBulkFileAudit('file.restore', { ids, fileNames, fileTypes }, req);
    logger.info({ fileIds: ids, fileNames }, 'Files restored from trash');

    // Publish file restored events in batch (optimized)
    await publishFileEventsBatch(
      fileInfo.map(file => ({
        eventType: EventTypes.FILE_RESTORED,
        eventData: {
          id: file.id,
          name: file.name,
          type: file.type,
          parentId: file.parentId || null,
          userId: req.ownerId,
        },
      }))
    );

    return { message: `Restored ${fileInfo.length} file(s) from trash` };
  };

  if (wantsProgressStream(req)) {
    return streamBulkProgress(res, { ids, processChunk: chunk => restoreFiles(chunk, req.ownerId), finalize });
  }

  await restoreFiles(ids, req.ownerId);
  sendSuccess(res, await finalize());
}

/**
 * Permanently delete files from trash
 */
async function deleteForeverController(req, res) {
  const { ids } = req.body;
  const treeCount = await countFileTree(ids, req.ownerId, { deleted: true });

  // Get file info for audit logging and events (from trash)
  const fileInfo = await getFileInfo(ids, req.ownerId, true);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  const finalize = async () => {
    // Log permanent deletion with details
    await logBulkFileAudit('file.delete.permanent', { ids, fileNames, fileTypes, metadata: { permanent: true } }, req);
    logger.info({ fileIds: ids, fileNames }, 'Files permanently deleted');

    // Publish file permanently deleted events in batch (optimized)
    await publishFileEventsBatch(
      fileInfo.map(file => ({
        eventType: EventTypes.FILE_PERMANENTLY_DELETED,
        eventData: {
          id: file.id,
          name: file.name,
          type: file.type,
          parentId: file.parentId || null,
          userId: req.ownerId,
          permanent: true,
        },
      }))
    );

    return { message: 'Files permanently deleted.' };
  };

  const queuedJobId = await enqueueLargeTreeOperation('delete-permanently', ids, req.ownerId, treeCount);
  if (queuedJobId) {
    await logBulkFileAudit('file.delete.permanent.queued', { ids, fileNames, fileTypes, metadata: { treeCount } }, req);
    return sendSuccess(res, { message: 'Permanent deletion queued.', queued: true, jobId: queuedJobId }, 202);
  }

  if (wantsProgressStream(req)) {
    return streamBulkProgress(res, {
      ids,
      processChunk: chunk => permanentlyDeleteFiles(chunk, req.ownerId),
      finalize,
    });
  }

  await permanentlyDeleteFiles(ids, req.ownerId);
  sendSuccess(res, await finalize());
}

/**
 * Empty trash (permanently delete all files in trash)
 */
async function emptyTrashController(req, res) {
  const treeCount = await countFileTree([], req.ownerId, { deleted: true, allTrash: true });
  if (treeCount === 0) return sendSuccess(res, { message: 'Trash is already empty' });
  const boss = getBoss();
  if (!boss) return sendError(res, 503, 'Background worker queue is unavailable');
  const jobId = await boss.send(FILE_OPERATION_QUEUE, { task: 'empty-trash', ids: [], userId: req.ownerId });
  await logAuditEvent(
    'file.delete.permanent.queued',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: null,
      metadata: {
        fileCount: treeCount,
        permanent: true,
        action: 'empty_trash',
        jobId,
      },
    },
    req
  );
  logger.info({ fileCount: treeCount, jobId }, 'Empty trash queued');
  sendSuccess(res, { message: `Deletion of ${treeCount} item(s) queued`, queued: true, jobId }, 202);
}

const deleteFilesExport = deleteFilesController;
const restoreFilesExport = restoreFilesController;
const deleteForever = deleteForeverController;
const emptyTrash = emptyTrashController;

export { deleteFilesExport as deleteFiles, listTrash, restoreFilesExport as restoreFiles, deleteForever, emptyTrash };
