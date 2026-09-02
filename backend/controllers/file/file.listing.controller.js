import { logger } from '../../config/logger.js';
import { recordAccess } from '../../services/accessTracker.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEvent } from '../../services/fileEvents.js';
import { createFolder, getFiles, renameFile as renameFileModel } from '../../models/file.model.js';
import { linkNewItemsToParentShare } from '../../services/shareLinking.js';
import { validateParentId } from '../../utils/controllerHelpers.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { validateSortBy, validateSortOrder } from '../../utils/validation.js';

/**
 * List files in a directory
 */
async function listFiles(req, res) {
  const { valid, parentId, error } = validateParentId(req, 'query');
  if (!valid) {
    return sendError(res, 400, error);
  }

  const sortBy = validateSortBy(req.query.sortBy) || 'modified';
  const order = validateSortOrder(req.query.order) || 'DESC';
  const files = await getFiles(req.ownerId, parentId, sortBy, order);

  // Stamp the directory as accessed, not its children (root is not a row).
  recordAccess(parentId, req.ownerId);

  // No HTTP caching for dynamic listings; we invalidate our own Redis cache on
  // rename/move/delete, and browser caching would show stale directory views.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  sendSuccess(res, files);
}

/**
 * Create a new folder
 */
async function addFolder(req, res) {
  const { name, parentId } = req.body;
  const folder = await createFolder(name, parentId, req.ownerId);

  await logAuditEvent(
    'folder.create',
    {
      status: 'success',
      resourceType: 'folder',
      resourceId: folder.id,
      metadata: { folderName: name, parentId },
    },
    req
  );
  logger.info({ folderId: folder.id, name }, 'Folder created');

  // Publish folder created event
  await publishFileEvent(EventTypes.FOLDER_CREATED, {
    id: folder.id,
    name: folder.name,
    type: folder.type,
    parentId,
    userId: req.ownerId,
  });

  await linkNewItemsToParentShare({ ownerId: req.ownerId, parentId, itemIds: [folder.id] });

  sendSuccess(res, folder);
}

/**
 * Rename a file or folder
 */
async function renameFile(req, res) {
  const { name, id } = req.body;

  const file = await renameFileModel(id, name, req.ownerId);
  if (!file) {
    return sendError(res, 404, 'Not found');
  }

  await logAuditEvent(
    'file.rename',
    {
      status: 'success',
      resourceType: file.type,
      resourceId: id,
      metadata: { newName: name, oldName: file.name },
    },
    req
  );
  logger.info({ fileId: id, newName: name }, 'File renamed');

  await publishFileEvent(EventTypes.FILE_RENAMED, {
    id,
    name,
    oldName: file.name,
    type: file.type,
    parentId: file.parentId || null,
    userId: req.ownerId,
  });

  sendSuccess(res, file);
}

export { listFiles, addFolder, renameFile };
