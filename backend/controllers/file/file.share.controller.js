import { logger } from '../../config/logger.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEventsBatch } from '../../services/fileEvents.js';
import { getFileInfo, getSharedFiles } from '../../models/file.model.js';
import { getShareLinks, linkItemsToParentShares, unshareRoots, upsertShareRoots } from '../../models/share.model.js';
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

  try {
    const links = {};

    if (shared) {
      const expiresAt = computeExpiresAt(expiry || '7d');

      const shareResult = await upsertShareRoots(ids, req.ownerId, expiresAt);
      await Promise.all(
        shareResult.created.map(async id => {
          const token = shareResult.tokens[id];
          await logAuditEvent(
            'share.create',
            {
              status: 'success',
              resourceType: 'share',
              resourceId: token,
              metadata: {
                fileId: id,
                fileCount: shareResult.counts[id],
                expiry: expiry || '7d',
              },
            },
            req
          );
          logger.info(
            { fileId: id, shareToken: token, fileCount: shareResult.counts[id], expiry: expiry || '7d' },
            'Share link created'
          );
        })
      );
      await Promise.all(
        ids.map(async id => {
          links[id] = await buildShareLink(shareResult.tokens[id], req);
        })
      );
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
      const fileInfo = await getFileInfo(ids, req.ownerId);
      await unshareRoots(ids, req.ownerId);

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

    if (shared) {
      sendSuccess(res, { links });
    } else {
      sendSuccess(res, { message: 'Files unshared successfully.' });
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * List shared files
 */
async function listShared(req, res) {
  const sortBy = validateSortBy(req.query.sortBy) || 'modified';
  const order = validateSortOrder(req.query.order) || 'DESC';
  const result = await getSharedFiles(req.ownerId, sortBy, order, {
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  const files = result.files || result;
  if (result.nextCursor) res.setHeader('X-Next-Cursor', result.nextCursor);
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
  const mappings = await linkItemsToParentShares(ids, req.ownerId);
  const links = {};
  for (const mapping of mappings) links[mapping.root_id] = await buildShareLink(mapping.share_id, req);
  const linkedIds = [...new Set(mappings.map(mapping => mapping.root_id))];
  const fileInfo = await getFileInfo(linkedIds, req.ownerId);

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
