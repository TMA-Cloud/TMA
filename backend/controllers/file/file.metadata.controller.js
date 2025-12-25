const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { setStarred, getStarredFiles, setShared, getSharedFiles, getRecursiveIds } = require('../../models/file.model');
const {
  createShareLink,
  getShareLink,
  deleteShareLink,
  addFilesToShare,
  removeFilesFromShares,
} = require('../../models/share.model');
const pool = require('../../config/db');
const { validateIdArray, validateSortBy, validateSortOrder, validateBoolean } = require('../../utils/validation');
const { buildShareLink } = require('../../utils/shareLink');
const { publishFileEvent, EventTypes } = require('../../services/fileEvents');

/**
 * Star or unstar files/folders
 */
async function starFilesController(req, res) {
  try {
    const { ids, starred } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    const validatedStarred = validateBoolean(starred);
    if (validatedStarred === null) {
      return sendError(res, 400, 'starred must be a boolean');
    }

    // Get file names for audit logging
    const fileInfoResult = await pool.query('SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2', [
      validatedIds,
      req.userId,
    ]);
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    await setStarred(validatedIds, validatedStarred, req.userId);

    // Log star/unstar with file details
    await logAuditEvent(
      validatedStarred ? 'file.star' : 'file.unstar',
      {
        status: 'success',
        resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
        resourceId: validatedIds[0], // First file ID
        metadata: {
          fileCount: validatedIds.length,
          fileIds: validatedIds,
          fileNames,
          fileTypes,
          starred: validatedStarred,
        },
      },
      req
    );
    logger.debug({ fileIds: validatedIds, fileNames, starred: validatedStarred }, 'Files starred status changed');

    // Publish file starred events
    for (const file of fileInfo) {
      await publishFileEvent(EventTypes.FILE_STARRED, {
        id: file.id,
        name: file.name,
        type: file.type,
        starred: validatedStarred,
        userId: req.userId,
      });
    }

    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * List starred files
 */
async function listStarred(req, res) {
  try {
    const sortBy = validateSortBy(req.query.sortBy) || 'modified';
    const order = validateSortOrder(req.query.order) || 'DESC';
    const files = await getStarredFiles(req.userId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Share or unshare files/folders
 */
async function shareFilesController(req, res) {
  try {
    const { ids, shared } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    const validatedShared = validateBoolean(shared);
    if (validatedShared === null) {
      return sendError(res, 400, 'shared must be a boolean');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // New contract: links[id] = full URL (respecting SHARE_BASE_URL / proxy headers)
      const links = {};

      if (validatedShared) {
        for (const id of validatedIds) {
          const treeIds = await getRecursiveIds([id], req.userId);
          let token = await getShareLink(id, req.userId);
          const isNewShare = !token;
          if (!token) {
            token = await createShareLink(id, req.userId, treeIds);
          } else {
            await addFilesToShare(token, treeIds);
          }

          links[id] = buildShareLink(token, req);

          // Log audit event for share creation
          if (isNewShare) {
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
          }
        }
        await setShared(validatedIds, true, req.userId);

        // Get file info for event publishing
        const fileInfoResult = await pool.query(
          'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2',
          [validatedIds, req.userId]
        );
        const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));

        // Publish file shared events
        for (const file of fileInfo) {
          await publishFileEvent(EventTypes.FILE_SHARED, {
            id: file.id,
            name: file.name,
            type: file.type,
            shared: true,
            userId: req.userId,
          });
        }
      } else {
        const treeIds = await getRecursiveIds(validatedIds, req.userId);
        await removeFilesFromShares(treeIds, req.userId);

        // Get file info for event publishing
        const fileInfoResult = await pool.query(
          'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2',
          [validatedIds, req.userId]
        );
        const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));

        for (const id of validatedIds) {
          await deleteShareLink(id, req.userId);

          // Log audit event for share deletion
          await logAuditEvent(
            'share.delete',
            {
              status: 'success',
              resourceType: 'share',
              resourceId: id,
              metadata: {
                fileId: id,
              },
            },
            req
          );
          logger.info({ fileId: id }, 'Share link deleted');
        }
        await setShared(validatedIds, false, req.userId);

        // Publish file unshared events
        for (const file of fileInfo) {
          await publishFileEvent(EventTypes.FILE_SHARED, {
            id: file.id,
            name: file.name,
            type: file.type,
            shared: false,
            userId: req.userId,
          });
        }
      }

      await client.query('COMMIT');
      sendSuccess(res, { success: true, links });
    } catch (err) {
      await client.query('ROLLBACK');
      sendError(res, 500, 'Server error', err);
    } finally {
      client.release();
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * List shared files
 */
async function listShared(req, res) {
  try {
    const sortBy = validateSortBy(req.query.sortBy) || 'modified';
    const order = validateSortOrder(req.query.order) || 'DESC';
    const files = await getSharedFiles(req.userId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get share links for files
 */
async function getShareLinksController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }

    const links = {};
    for (const id of validatedIds) {
      const token = await getShareLink(id, req.userId);
      if (token) {
        links[id] = buildShareLink(token, req);
      }
    }

    sendSuccess(res, { success: true, links });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Link files to parent's share link
 */
async function linkParentShareController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    const links = {};
    for (const id of validatedIds) {
      const parentRes = await pool.query('SELECT parent_id FROM files WHERE id = $1 AND user_id = $2', [
        id,
        req.userId,
      ]);
      const parentId = parentRes.rows[0]?.parent_id;
      if (!parentId) continue;
      const shareId = await getShareLink(parentId, req.userId);
      if (!shareId) continue;
      const treeIds = await getRecursiveIds([id], req.userId);
      await addFilesToShare(shareId, treeIds);
      await setShared([id], true, req.userId);
      links[id] = buildShareLink(shareId, req);

      // Get file info for event publishing
      const fileInfoResult = await pool.query('SELECT id, name, type FROM files WHERE id = $1 AND user_id = $2', [
        id,
        req.userId,
      ]);
      if (fileInfoResult.rows[0]) {
        const file = fileInfoResult.rows[0];
        await publishFileEvent(EventTypes.FILE_SHARED, {
          id: file.id,
          name: file.name,
          type: file.type,
          shared: true,
          userId: req.userId,
        });
      }
    }
    sendSuccess(res, { success: true, links });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  starFiles: starFilesController,
  listStarred,
  shareFiles: shareFilesController,
  listShared,
  getShareLinks: getShareLinksController,
  linkParentShare: linkParentShareController,
};
