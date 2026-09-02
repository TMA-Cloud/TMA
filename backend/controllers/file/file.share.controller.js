import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import { getFileInfo, getRecursiveIds, getSharedFiles, setShared } from '../../models/file.model.js';
import {
  addFilesToShare,
  createShareLink,
  deleteShareLinks,
  getShareLinks,
  removeFilesFromShares,
  updateShareExpiry,
} from '../../models/share.model.js';
import { buildShareLink } from '../../utils/shareLink.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { validateSortBy, validateSortOrder } from '../../utils/validation.js';

/**
 * Convert expiry tag to a Date (or null for unlimited).
 * Accepted values: "7d", "30d", "never". Default: "7d".
 */
function computeExpiresAt(expiry) {
  if (expiry === 'never') return null;
  const days = expiry === '30d' ? 30 : 7;
  return new Date(Date.now() + days * 86400000);
}

/**
 * Share or unshare files/folders
 */
async function shareFilesController(req, res) {
  const { ids, expiry, shared = true } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const links = {};

    if (shared) {
      const expiresAt = computeExpiresAt(expiry || '7d');

      const existingShareLinks = await getShareLinks(ids, req.ownerId);

      const sharePromises = ids.map(async id => {
        const treeIds = await getRecursiveIds([id], req.ownerId);
        let token = existingShareLinks[id];

        if (!token) {
          token = await createShareLink(id, req.ownerId, treeIds, expiresAt);

          await logAuditEvent(
            'share.create',
            {
              status: 'success',
              resourceType: 'share',
              resourceId: token,
              metadata: {
                fileId: id,
                fileCount: treeIds.length,
                expiry: expiry || '7d',
              },
            },
            req
          );
          logger.info(
            { fileId: id, shareToken: token, fileCount: treeIds.length, expiry: expiry || '7d' },
            'Share link created'
          );
        } else {
          await addFilesToShare(token, treeIds);
          await updateShareExpiry(token, expiresAt);
        }

        links[id] = await buildShareLink(token, req);
      });

      await Promise.all(sharePromises);
      await setShared(ids, true, req.ownerId);

      const fileInfo = await getFileInfo(ids, req.ownerId);

      await publishFileEventsBatch(
        fileInfo.map(file => ({
          eventType: EventTypes.FILE_SHARED,
          eventData: {
            id: file.id,
            name: file.name,
            type: file.type,
            parentId: file.parentId || null,
            shared: true,
            userId: req.ownerId,
          },
        }))
      );
    } else {
      const treeIds = await getRecursiveIds(ids, req.ownerId);
      await removeFilesFromShares(treeIds, req.ownerId);

      const fileInfo = await getFileInfo(ids, req.ownerId);

      await deleteShareLinks(ids, req.ownerId);

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

      await setShared(ids, false, req.ownerId);

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
            userId: req.ownerId,
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
  const files = await getSharedFiles(req.ownerId, sortBy, order);
  sendSuccess(res, files);
}

/**
 * Get share links for files
 */
async function getShareLinksController(req, res) {
  const { ids } = req.body;

  const shareLinksMap = await getShareLinks(ids, req.ownerId);

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

  const parentRes = await pool.query('SELECT id, parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [
    ids,
    req.ownerId,
  ]);

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

  const uniqueParentIds = [...new Set(parentIds)];
  const parentShareLinks = await getShareLinks(uniqueParentIds, req.ownerId);

  // Group files by their parent's share link.
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

  const links = {};
  const allTreeIds = [];
  const allFileIdsToShare = [];

  for (const [shareId, fileIds] of shareIdToFileIds.entries()) {
    const treeIds = await getRecursiveIds(fileIds, req.ownerId);
    allTreeIds.push(...treeIds);
    allFileIdsToShare.push(...fileIds);

    await addFilesToShare(shareId, treeIds);

    const shareUrl = buildShareLink(shareId, req);
    for (const fileId of fileIds) {
      links[fileId] = shareUrl;
    }
  }

  if (allFileIdsToShare.length > 0) {
    await setShared(allFileIdsToShare, true, req.ownerId);
  }

  const fileInfo = await getFileInfo(allFileIdsToShare, req.ownerId);

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
        userId: req.ownerId,
      },
    }))
  );

  sendSuccess(res, { links });
}

const shareFiles = shareFilesController;
const getShareLinksControllerExport = getShareLinksController;
const linkParentShare = linkParentShareController;

export { shareFiles, listShared, getShareLinksControllerExport as getShareLinks, linkParentShare };
