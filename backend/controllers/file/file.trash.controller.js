import { logger } from '../../config/logger.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import {
  deleteFiles,
  getFileInfo,
  getTrashFiles,
  permanentlyDeleteFiles,
  restoreFiles,
} from '../../models/file.model.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { validateSortBy, validateSortOrder } from '../../utils/validation.js';
import { logBulkFileAudit, wantsProgressStream, streamBulkProgress } from '../../utils/controllerHelpers.js';

/**
 * Delete files/folders (move to trash)
 */
async function deleteFilesController(req, res) {
  const { ids } = req.body;

  // Get file info for audit logging and events
  const fileInfo = await getFileInfo(ids, req.ownerId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  const finalize = async () => {
    // Log file deletion (soft delete to trash) with details
    await logBulkFileAudit('file.delete', { ids, fileNames, fileTypes, metadata: { permanent: false } }, req);
    return { message: 'Files moved to trash.' };
  };

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
  const files = await getTrashFiles(req.ownerId, sortBy, order, true);
  sendSuccess(res, files);
}

/**
 * Restore files from trash
 */
async function restoreFilesController(req, res) {
  const { ids } = req.body;

  // Get file info for audit logging and events (from trash)
  const fileInfo = await getFileInfo(ids, req.ownerId, true);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  if (fileInfo.length === 0) {
    return sendError(res, 404, 'No files found in trash to restore');
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
  // Get all trash files for the user
  const trashFiles = await getTrashFiles(req.ownerId);

  if (trashFiles.length === 0) {
    sendSuccess(res, { message: 'Trash is already empty' });
  }

  const allIds = trashFiles.map(f => f.id);
  const fileNames = trashFiles.map(f => f.name);
  const fileTypes = trashFiles.map(f => f.type);

  await permanentlyDeleteFiles(allIds, req.ownerId);

  // Log empty trash action with details
  await logAuditEvent(
    'file.delete.permanent',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: allIds[0] || null,
      metadata: {
        fileCount: allIds.length,
        fileIds: allIds,
        fileNames,
        fileTypes,
        permanent: true,
        action: 'empty_trash',
      },
    },
    req
  );
  logger.info({ fileCount: allIds.length, fileNames }, 'Trash emptied');

  // Publish file permanently deleted events in batch (optimized)
  await publishFileEventsBatch(
    trashFiles.map(file => ({
      eventType: EventTypes.FILE_PERMANENTLY_DELETED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: file.parentId || file.parent_id || null,
        userId: req.ownerId,
        permanent: true,
        action: 'empty_trash',
      },
    }))
  );

  sendSuccess(res, { message: `Deleted ${allIds.length} file(s) from trash` });
}

const deleteFilesExport = deleteFilesController;
const restoreFilesExport = restoreFilesController;
const deleteForever = deleteForeverController;
const emptyTrash = emptyTrashController;

export { deleteFilesExport as deleteFiles, listTrash, restoreFilesExport as restoreFiles, deleteForever, emptyTrash };
