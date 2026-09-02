/**
 * File Metadata Controller
 *
 * Handles the non-content file metadata concerns: "Get Info", and starring.
 * Share-link handling lives in ./file.share.controller.js and is re-exported
 * here so the public surface and import path (via controllers/file.controller.js)
 * stay unchanged.
 */

import { logger } from '../../config/logger.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import {
  getFileInfo,
  getFolderPathSegments,
  getFolderTree,
  getStarredFiles,
  setStarred,
} from '../../models/file.model.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { validateSortBy, validateSortOrder } from '../../utils/validation.js';

/**
 * Get basic info for a single file or folder (for "Get Info" UI).
 */
async function getFileInfoController(req, res) {
  const { id } = req.params;
  const files = await getFileInfo([id], req.ownerId);

  if (!files || files.length === 0) {
    return sendError(res, 404, 'File not found');
  }
  const file = files[0];

  // Build the location from the real parent chain, not the client's currentPath
  // (which is wrong when "Get Info" is opened from search results).
  const locationPath = await getFolderPathSegments(file.parentId, req.ownerId);

  // Folders also report recursive counts and total size.
  if (file.type === 'folder') {
    const tree = await getFolderTree(id, req.ownerId);
    let totalSize = 0;
    let fileCount = 0;
    let folderCount = 0;

    for (const entry of tree) {
      if (entry.type === 'file') {
        fileCount += 1;
        if (entry.size != null) {
          const sizeValue = typeof entry.size === 'string' ? Number(entry.size) || 0 : entry.size || 0;
          totalSize += sizeValue;
        }
      } else if (entry.type === 'folder' && entry.id !== id) {
        folderCount += 1;
      }
    }

    return sendSuccess(res, {
      ...file,
      locationPath,
      folderInfo: {
        totalSize,
        fileCount,
        folderCount,
      },
    });
  }

  return sendSuccess(res, { ...file, locationPath });
}

/**
 * Star or unstar files/folders
 */
async function starFilesController(req, res) {
  const { ids, starred } = req.body;

  const fileInfo = await getFileInfo(ids, req.ownerId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  await setStarred(ids, starred, req.ownerId);

  await logAuditEvent(
    starred ? 'file.star' : 'file.unstar',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file',
      resourceId: ids[0],
      metadata: {
        fileCount: ids.length,
        fileIds: ids,
        fileNames,
        fileTypes,
        starred,
      },
    },
    req
  );
  logger.debug({ fileIds: ids, fileNames, starred }, 'Files starred status changed');

  await publishFileEventsBatch(
    fileInfo.map(file => ({
      eventType: EventTypes.FILE_STARRED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: file.parentId || null,
        starred,
        userId: req.ownerId,
      },
    }))
  );

  sendSuccess(res, { message: 'File starred status updated.' });
}

/**
 * List starred files
 */
async function listStarred(req, res) {
  const sortBy = validateSortBy(req.query.sortBy) || 'modified';
  const order = validateSortOrder(req.query.order) || 'DESC';
  const files = await getStarredFiles(req.ownerId, sortBy, order);
  sendSuccess(res, files);
}

const getFileInfoControllerExport = getFileInfoController;
const starFiles = starFilesController;

export { getFileInfoControllerExport as getFileInfo, starFiles, listStarred };
export { shareFiles, listShared, getShareLinks, linkParentShare } from './file.share.controller.js';
