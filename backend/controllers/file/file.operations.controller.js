const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { moveFiles, copyFiles } = require('../../models/file.model');
const pool = require('../../config/db');
const { userOperationLock } = require('../../utils/mutex');
const { validateId, validateIdArray } = require('../../utils/validation');
const { publishFileEvent, EventTypes } = require('../../services/fileEvents');

/**
 * Move files or folders to a different location
 */
async function moveFilesController(req, res) {
  try {
    const { ids, parentId = null } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    const validatedParentId = parentId ? validateId(parentId) : null;
    if (parentId && !validatedParentId) {
      return sendError(res, 400, 'Invalid parent ID');
    }

    // Get file and target folder names for audit logging
    const fileInfoResult = await pool.query('SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2', [
      validatedIds,
      req.userId,
    ]);
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    let targetFolderName = 'Root';
    if (validatedParentId) {
      const targetResult = await pool.query('SELECT name FROM files WHERE id = $1 AND user_id = $2', [
        validatedParentId,
        req.userId,
      ]);
      if (targetResult.rows[0]) {
        targetFolderName = targetResult.rows[0].name;
      }
    }

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

    // Publish file moved events
    for (const file of fileInfo) {
      await publishFileEvent(EventTypes.FILE_MOVED, {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: validatedParentId,
        targetFolderName,
        userId: req.userId,
      });
    }

    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Copy files or folders to a different location
 */
async function copyFilesController(req, res) {
  try {
    const { ids, parentId = null } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    const validatedParentId = parentId ? validateId(parentId) : null;
    if (parentId && !validatedParentId) {
      return sendError(res, 400, 'Invalid parent ID');
    }

    // Get file and target folder names for audit logging
    const fileInfoResult = await pool.query('SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2', [
      validatedIds,
      req.userId,
    ]);
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    let targetFolderName = 'Root';
    if (validatedParentId) {
      const targetResult = await pool.query('SELECT name FROM files WHERE id = $1 AND user_id = $2', [
        validatedParentId,
        req.userId,
      ]);
      if (targetResult.rows[0]) {
        targetFolderName = targetResult.rows[0].name;
      }
    }

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

    // Publish file copied events
    for (const file of newFilesResult.rows) {
      await publishFileEvent(EventTypes.FILE_COPIED, {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: validatedParentId,
        targetFolderName,
        userId: req.userId,
      });
    }

    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  moveFiles: moveFilesController,
  copyFiles: copyFilesController,
};
