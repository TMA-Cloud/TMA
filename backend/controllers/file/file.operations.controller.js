const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { moveFiles, copyFiles, getFileInfo, getTargetFolderName } = require('../../models/file.model');
const pool = require('../../config/db');
const { userOperationLock } = require('../../utils/mutex');
const { publishFileEventsBatch, EventTypes } = require('../../services/fileEvents');
const { validateFileIds, validateParentId } = require('../../utils/controllerHelpers');

/**
 * Move files or folders to a different location
 */
async function moveFilesController(req, res) {
  const { valid: idsValid, ids: validatedIds, error: idsError } = validateFileIds(req);
  if (!idsValid) {
    return sendError(res, 400, idsError);
  }
  const { valid, parentId: validatedParentId, error } = validateParentId(req);
  if (!valid) {
    return sendError(res, 400, error);
  }

  // Get file info for audit logging
  const fileInfo = await getFileInfo(validatedIds, req.userId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  const targetFolderName = await getTargetFolderName(validatedParentId, req.userId);

  await userOperationLock(req.userId, async () => {
    await moveFiles(validatedIds, validatedParentId, req.userId);
  });

  // Log file move with details
  await logAuditEvent(
    'file.move',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0],
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames,
        fileTypes,
        targetParentId: validatedParentId,
        targetFolderName,
      },
    },
    req
  );
  logger.info({ fileIds: validatedIds, fileNames, targetFolderName }, 'Files moved');

  // Publish file moved events in batch (optimized)
  await publishFileEventsBatch(
    fileInfo.map(file => ({
      eventType: EventTypes.FILE_MOVED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: validatedParentId,
        targetFolderName,
        userId: req.userId,
      },
    }))
  );

  sendSuccess(res, { success: true });
}

/**
 * Copy files or folders to a different location
 */
async function copyFilesController(req, res) {
  const { valid: idsValid, ids: validatedIds, error: idsError } = validateFileIds(req);
  if (!idsValid) {
    return sendError(res, 400, idsError);
  }
  const { valid, parentId: validatedParentId, error } = validateParentId(req);
  if (!valid) {
    return sendError(res, 400, error);
  }

  // Get file info for audit logging
  const fileInfo = await getFileInfo(validatedIds, req.userId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  const targetFolderName = await getTargetFolderName(validatedParentId, req.userId);

  await userOperationLock(req.userId, async () => {
    await copyFiles(validatedIds, validatedParentId, req.userId);
  });

  // Log file copy with details
  await logAuditEvent(
    'file.copy',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0],
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames,
        fileTypes,
        targetParentId: validatedParentId,
        targetFolderName,
      },
    },
    req
  );
  logger.info({ fileIds: validatedIds, fileNames, targetFolderName }, 'Files copied');

  // Query for newly created files (copies) to get their IDs
  // We find them by matching name, type, and parentId, and created after the copy operation
  const newFilesResult = await pool.query(
    'SELECT id, name, type FROM files WHERE name = ANY($1) AND type = ANY($2) AND parent_id = $3 AND user_id = $4 ORDER BY modified DESC LIMIT $5',
    [fileNames, fileTypes, validatedParentId, req.userId, validatedIds.length]
  );

  // Publish file copied events in batch (optimized)
  await publishFileEventsBatch(
    newFilesResult.rows.map(file => ({
      eventType: EventTypes.FILE_COPIED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: validatedParentId,
        targetFolderName,
        userId: req.userId,
      },
    }))
  );

  sendSuccess(res, { success: true });
}

module.exports = {
  moveFiles: moveFilesController,
  copyFiles: copyFilesController,
};
