const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const {
  setStarred,
  getStarredFiles,
  setShared,
  getSharedFiles,
  getRecursiveIds,
  getFileInfo,
} = require('../../models/file.model');
const {
  createShareLink,
  getShareLinks,
  deleteShareLinks,
  addFilesToShare,
  removeFilesFromShares,
} = require('../../models/share.model');
const pool = require('../../config/db');
const { validateSortBy, validateSortOrder } = require('../../utils/validation');
const { buildShareLink } = require('../../utils/shareLink');
const { publishFileEventsBatch, EventTypes } = require('../../services/fileEvents');
/**
 * Star or unstar files/folders
 */
async function starFilesController(req, res) {
  const { ids, starred } = req.body;

  // Get file info for audit logging and events
  const fileInfo = await getFileInfo(ids, req.userId);
  const fileNames = fileInfo.map(f => f.name);
  const fileTypes = fileInfo.map(f => f.type);

  await setStarred(ids, starred, req.userId);

  // Log star/unstar with file details
  await logAuditEvent(
    starred ? 'file.star' : 'file.unstar',
    {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: ids[0], // First file ID
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

  // Publish file starred events in batch (optimized)
  await publishFileEventsBatch(
    fileInfo.map(file => ({
      eventType: EventTypes.FILE_STARRED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: file.parentId || null,
        starred,
        userId: req.userId,
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
  const files = await getStarredFiles(req.userId, sortBy, order);
  sendSuccess(res, files);
}

/**
 * Share or unshare files/folders
 */
async function shareFilesController(req, res) {
  const { ids, shared } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // New contract: links[id] = full URL (respecting share base URL from database / proxy headers)
    const links = {};

    if (shared) {
      // Bulk operation: Get all existing share links at once
      const existingShareLinks = await getShareLinks(ids, req.userId);

      // Process each file to create/update share links
      const sharePromises = ids.map(async id => {
        const treeIds = await getRecursiveIds([id], req.userId);
        let token = existingShareLinks[id];

        if (!token) {
          token = await createShareLink(id, req.userId, treeIds);

          // Log audit event for share creation
          await logAuditEvent(
            'share.create',
            {
              status: 'success',
              resourceType: 'share',
              resourceId: token,
              metadata: {
                fileId: id,
                fileCount: treeIds.length,
              },
            },
            req
          );
          logger.info({ fileId: id, shareToken: token, fileCount: treeIds.length }, 'Share link created');
        } else {
          await addFilesToShare(token, treeIds);
        }

        links[id] = await buildShareLink(token, req);
      });

      // Wait for all share operations to complete
      await Promise.all(sharePromises);
      await setShared(ids, true, req.userId);

      // Get file info for event publishing
      const fileInfo = await getFileInfo(ids, req.userId);

      // Publish file shared events in batch (optimized)
      await publishFileEventsBatch(
        fileInfo.map(file => ({
          eventType: EventTypes.FILE_SHARED,
          eventData: {
            id: file.id,
            name: file.name,
            type: file.type,
            parentId: file.parentId || null,
            shared: true,
            userId: req.userId,
          },
        }))
      );
    } else {
      const treeIds = await getRecursiveIds(ids, req.userId);
      await removeFilesFromShares(treeIds, req.userId);

      // Get file info for event publishing
      const fileInfo = await getFileInfo(ids, req.userId);

      // Bulk delete all share links at once
      await deleteShareLinks(ids, req.userId);

      // Log audit events for share deletions (bulk)
      await logAuditEvent(
        'share.delete',
        {
          status: 'success',
          resourceType: 'share',
          resourceId: ids[0] || null,
          metadata: {
            fileCount: ids.length,
            fileIds: ids,
          },
        },
        req
      );
      logger.info({ fileIds: ids, fileCount: ids.length }, 'Share links deleted');

      await setShared(ids, false, req.userId);

      // Publish file unshared events in batch (optimized)
      await publishFileEventsBatch(
        fileInfo.map(file => ({
          eventType: EventTypes.FILE_SHARED,
          eventData: {
            id: file.id,
            name: file.name,
            type: file.type,
            parentId: file.parentId || null,
            shared: false,
            userId: req.userId,
          },
        }))
      );
    }

    await client.query('COMMIT');
    if (shared) {
      sendSuccess(res, { links });
    } else {
      sendSuccess(res, { message: 'Files unshared successfully.' });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    sendError(res, 500, 'Server error', err);
  } finally {
    client.release();
  }
}

/**
 * List shared files
 */
async function listShared(req, res) {
  const sortBy = validateSortBy(req.query.sortBy) || 'modified';
  const order = validateSortOrder(req.query.order) || 'DESC';
  const files = await getSharedFiles(req.userId, sortBy, order);
  sendSuccess(res, files);
}

/**
 * Get share links for files
 */
async function getShareLinksController(req, res) {
  const { ids } = req.body;

  // Bulk operation: Get all share links at once
  const shareLinksMap = await getShareLinks(ids, req.userId);

  // Build links object with full URLs
  const links = {};
  for (const id of ids) {
    const token = shareLinksMap[id];
    if (token) {
      links[id] = await buildShareLink(token, req);
    }
  }
  sendSuccess(res, { links });
}

/**
 * Link files to parent's share link
 */
async function linkParentShareController(req, res) {
  const { ids } = req.body;

  // Bulk operation: Get all parent IDs at once
  const parentRes = await pool.query('SELECT id, parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [
    ids,
    req.userId,
  ]);

  // Build map of fileId -> parentId
  const fileToParent = {};
  const parentIds = [];
  for (const row of parentRes.rows) {
    if (row.parent_id) {
      fileToParent[row.id] = row.parent_id;
      parentIds.push(row.parent_id);
    }
  }

  if (parentIds.length === 0) {
    return sendSuccess(res, { links: {} });
  }

  // Bulk operation: Get all parent share links at once
  const uniqueParentIds = [...new Set(parentIds)];
  const parentShareLinks = await getShareLinks(uniqueParentIds, req.userId);

  // Group files by their parent's share link
  const shareIdToFileIds = new Map();
  for (const id of ids) {
    const parentId = fileToParent[id];
    if (!parentId) continue;
    const shareId = parentShareLinks[parentId];
    if (!shareId) continue;

    if (!shareIdToFileIds.has(shareId)) {
      shareIdToFileIds.set(shareId, []);
    }
    shareIdToFileIds.get(shareId).push(id);
  }

  // Process each share link group
  const links = {};
  const allTreeIds = [];
  const allFileIdsToShare = [];

  for (const [shareId, fileIds] of shareIdToFileIds.entries()) {
    // Get recursive IDs for all files in this group
    const treeIds = await getRecursiveIds(fileIds, req.userId);
    allTreeIds.push(...treeIds);
    allFileIdsToShare.push(...fileIds);

    // Add all files to the share in one operation
    await addFilesToShare(shareId, treeIds);

    // Build share link URL
    const shareUrl = buildShareLink(shareId, req);
    for (const fileId of fileIds) {
      links[fileId] = shareUrl;
    }
  }

  // Bulk update shared status for all files
  if (allFileIdsToShare.length > 0) {
    await setShared(allFileIdsToShare, true, req.userId);
  }

  // Get file info for event publishing (bulk)
  const fileInfo = await getFileInfo(allFileIdsToShare, req.userId);

  // Publish file shared events in batch (optimized)
  await publishFileEventsBatch(
    fileInfo.map(file => ({
      eventType: EventTypes.FILE_SHARED,
      eventData: {
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: file.parentId || null,
        shared: true,
        userId: req.userId,
      },
    }))
  );

  sendSuccess(res, { links });
}

module.exports = {
  starFiles: starFilesController,
  listStarred,
  shareFiles: shareFilesController,
  listShared,
  getShareLinks: getShareLinksController,
  linkParentShare: linkParentShareController,
};
