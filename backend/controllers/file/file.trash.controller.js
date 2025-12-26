const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { deleteFiles, getTrashFiles, restoreFiles, permanentlyDeleteFiles } = require('../../models/file.model');
const pool = require('../../config/db');
const { validateIdArray, validateSortBy, validateSortOrder } = require('../../utils/validation');
const { publishFileEventsBatch, EventTypes } = require('../../services/fileEvents');

/**
 * Delete files/folders (move to trash)
 */
async function deleteFilesController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }

    // Get file names and parent_id for audit logging and events
    const fileInfoResult = await pool.query(
      'SELECT id, name, type, parent_id FROM files WHERE id = ANY($1) AND user_id = $2',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type, parentId: f.parent_id }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    await deleteFiles(validatedIds, req.userId);

    // Log file deletion (soft delete to trash) with details
    await logAuditEvent(
      'file.delete',
      {
        status: 'success',
        resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
        resourceId: validatedIds[0],
        metadata: {
          fileCount: validatedIds.length,
          fileIds: validatedIds,
          fileNames,
          fileTypes,
          permanent: false,
        },
      },
      req
    );
    logger.info({ fileIds: validatedIds, fileNames }, 'Files moved to trash');

    // Publish file deleted events in batch (optimized)
    await publishFileEventsBatch(
      fileInfo.map(file => ({
        eventType: EventTypes.FILE_DELETED,
        eventData: {
          id: file.id,
          name: file.name,
          type: file.type,
          parentId: file.parentId || null,
          userId: req.userId,
          permanent: false,
        },
      }))
    );

    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * List files in trash
 */
async function listTrash(req, res) {
  try {
    const sortBy = validateSortBy(req.query.sortBy) || 'deletedAt';
    const order = validateSortOrder(req.query.order) || 'DESC';
    const files = await getTrashFiles(req.userId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Restore files from trash
 */
async function restoreFilesController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }

    // Get file names and parent_id for audit logging and events (from trash)
    const fileInfoResult = await pool.query(
      'SELECT id, name, type, parent_id FROM files WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NOT NULL',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type, parentId: f.parent_id }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    if (fileInfo.length === 0) {
      return sendError(res, 404, 'No files found in trash to restore');
    }

    await restoreFiles(validatedIds, req.userId);

    // Log file restore with details
    await logAuditEvent(
      'file.restore',
      {
        status: 'success',
        resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
        resourceId: validatedIds[0],
        metadata: {
          fileCount: validatedIds.length,
          fileIds: validatedIds,
          fileNames,
          fileTypes,
        },
      },
      req
    );
    logger.info({ fileIds: validatedIds, fileNames }, 'Files restored from trash');

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

    sendSuccess(res, { success: true, message: `Restored ${fileInfo.length} file(s) from trash` });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Permanently delete files from trash
 */
async function deleteForeverController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }

    // Get file names and parent_id for audit logging and events (from trash)
    const fileInfoResult = await pool.query(
      'SELECT id, name, type, parent_id FROM files WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NOT NULL',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type, parentId: f.parent_id }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    await permanentlyDeleteFiles(validatedIds, req.userId);

    // Log permanent deletion with details
    await logAuditEvent(
      'file.delete.permanent',
      {
        status: 'success',
        resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
        resourceId: validatedIds[0],
        metadata: {
          fileCount: validatedIds.length,
          fileIds: validatedIds,
          fileNames,
          fileTypes,
          permanent: true,
        },
      },
      req
    );
    logger.info({ fileIds: validatedIds, fileNames }, 'Files permanently deleted');

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

    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Empty trash (permanently delete all files in trash)
 */
async function emptyTrashController(req, res) {
  try {
    // Get all trash files for the user
    const trashFiles = await getTrashFiles(req.userId);

    if (trashFiles.length === 0) {
      return sendSuccess(res, { success: true, message: 'Trash is already empty' });
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

    sendSuccess(res, { success: true, message: `Deleted ${allIds.length} file(s) from trash` });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  deleteFiles: deleteFilesController,
  listTrash,
  restoreFiles: restoreFilesController,
  deleteForever: deleteForeverController,
  emptyTrash: emptyTrashController,
};
