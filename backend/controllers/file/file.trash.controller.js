const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const {
  deleteFiles,
  getTrashFiles,
  restoreFiles,
  permanentlyDeleteFiles,
  getFileInfo,
} = require('../../models/file.model');
const { validateSortBy, validateSortOrder } = require('../../utils/validation');
const { publishFileEventsBatch, EventTypes } = require('../../services/fileEvents');
/**
 * Delete files/folders (move to trash)
 */
async function deleteFilesController(req, res) {
  const { ids } = req.body;

  // Get file info for audit logging and events
  const fileInfo = await getFileInfo(ids, req.userId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  await deleteFiles(ids, req.userId);

  // Log file deletion (soft delete to trash) with details
  await logAuditEvent(
    'file.delete',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: ids[0],
      metadata: {
        fileCount: ids.length,
        fileIds: ids,
        fileNames,
        fileTypes,
        permanent: false,
      },
    },
    req
  );
  sendSuccess(res, { message: 'Files moved to trash.' });
}

/**
 * List files in trash
 */
async function listTrash(req, res) {
  const sortBy = validateSortBy(req.query.sortBy) || 'deletedAt';
  const order = validateSortOrder(req.query.order) || 'DESC';
  const files = await getTrashFiles(req.userId, sortBy, order);
  sendSuccess(res, files);
}

/**
 * Restore files from trash
 */
async function restoreFilesController(req, res) {
  const { ids } = req.body;

  // Get file info for audit logging and events (from trash)
  const fileInfo = await getFileInfo(ids, req.userId, true);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  if (fileInfo.length === 0) {
    return sendError(res, 404, 'No files found in trash to restore');
  }

  await restoreFiles(ids, req.userId);

  // Log file restore with details
  await logAuditEvent(
    'file.restore',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: ids[0],
      metadata: {
        fileCount: ids.length,
        fileIds: ids,
        fileNames,
        fileTypes,
      },
    },
    req
  );
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
        userId: req.userId,
      },
    }))
  );

  sendSuccess(res, { message: `Restored ${fileInfo.length} file(s) from trash` });
}

/**
 * Permanently delete files from trash
 */
async function deleteForeverController(req, res) {
  const { ids } = req.body;

  // Get file info for audit logging and events (from trash)
  const fileInfo = await getFileInfo(ids, req.userId, true);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  await permanentlyDeleteFiles(ids, req.userId);

  // Log permanent deletion with details
  await logAuditEvent(
    'file.delete.permanent',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: ids[0],
      metadata: {
        fileCount: ids.length,
        fileIds: ids,
        fileNames,
        fileTypes,
        permanent: true,
      },
    },
    req
  );
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
        userId: req.userId,
        permanent: true,
      },
    }))
  );

  sendSuccess(res, { message: 'Files permanently deleted.' });
}

/**
 * Empty trash (permanently delete all files in trash)
 */
async function emptyTrashController(req, res) {
  // Get all trash files for the user
  const trashFiles = await getTrashFiles(req.userId);

  if (trashFiles.length === 0) {
    sendSuccess(res, { message: 'Trash is already empty' });
  }

  const allIds = trashFiles.map(f => f.id);
  const fileNames = trashFiles.map(f => f.name);
  const fileTypes = trashFiles.map(f => f.type);

  await permanentlyDeleteFiles(allIds, req.userId);

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
        userId: req.userId,
        permanent: true,
        action: 'empty_trash',
      },
    }))
  );

  sendSuccess(res, { message: `Deleted ${allIds.length} file(s) from trash` });
}

module.exports = {
  deleteFiles: deleteFilesController,
  listTrash,
  restoreFiles: restoreFilesController,
  deleteForever: deleteForeverController,
  emptyTrash: emptyTrashController,
};
