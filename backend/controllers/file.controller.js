const { validateAndResolveFile } = require('../utils/fileDownload');
const { sendError, sendSuccess } = require('../utils/response');
const {
  getFiles,
  createFolder,
  createFile,
  moveFiles,
  copyFiles,
  getFile,
  renameFile,
  setStarred,
  getStarredFiles,
  setShared,
  getSharedFiles,
  getRecursiveIds,
  deleteFiles,
  getTrashFiles,
  permanentlyDeleteFiles,
  searchFiles,
  getFileStats,
} = require('../models/file.model');
const {
  createShareLink,
  getShareLink,
  deleteShareLink,
  addFilesToShare,
  removeFilesFromShares,
} = require('../models/share.model');
const pool = require('../config/db');
const { userOperationLock, fileOperationLock } = require('../utils/mutex');
const {
  validateId,
  validateIdArray,
  validateFileName,
  validateSortBy,
  validateSortOrder,
  validateSearchQuery,
  validateLimit,
  validateBoolean,
  validateFileUpload,
} = require('../utils/validation');

async function listFiles(req, res) {
  try {
    const parentId = req.query.parentId ? validateId(req.query.parentId) : null;
    if (req.query.parentId && !parentId) {
      return sendError(res, 400, 'Invalid parent ID');
    }
    const sortBy = validateSortBy(req.query.sortBy) || 'modified';
    const order = validateSortOrder(req.query.order) || 'DESC';
    const files = await getFiles(req.userId, parentId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function addFolder(req, res) {
  try {
    const { name, parentId = null } = req.body;
    if (!name || !validateFileName(name)) {
      return sendError(res, 400, 'Invalid folder name');
    }
    const validatedParentId = parentId ? validateId(parentId) : null;
    if (parentId && !validatedParentId) {
      return sendError(res, 400, 'Invalid parent ID');
    }
    const folder = await createFolder(name, validatedParentId, req.userId);
    sendSuccess(res, folder);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function uploadFile(req, res) {
  try {
    if (!req.file) {
      return sendError(res, 400, 'No file uploaded');
    }

    // Validate filename
    if (!validateFileName(req.file.originalname)) {
      return sendError(res, 400, 'Invalid file name');
    }

    // Validate for security concerns (MIME spoofing detection, etc.)
    // This logs warnings but doesn't block uploads - cloud storage accepts all file types
    validateFileUpload(req.file.mimetype, req.file.originalname);

    const parentId = req.body.parentId ? validateId(req.body.parentId) : null;
    if (req.body.parentId && !parentId) {
      return sendError(res, 400, 'Invalid parent ID');
    }

    const file = await userOperationLock(req.userId, async () => {
      return await createFile(
        req.file.originalname,
        req.file.size,
        req.file.mimetype,
        req.file.path,
        parentId,
        req.userId
      );
    });
    sendSuccess(res, file);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

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
    await userOperationLock(req.userId, async () => {
      await moveFiles(validatedIds, validatedParentId, req.userId);
    });
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

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
    await userOperationLock(req.userId, async () => {
      await copyFiles(validatedIds, validatedParentId, req.userId);
    });
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function downloadFile(req, res) {
  try {
    const fileId = validateId(req.params.id);
    if (!fileId) {
      return sendError(res, 400, 'Invalid file ID');
    }
    const file = await getFile(fileId, req.userId);
    if (!file) {
      return sendError(res, 404, 'File not found');
    }

    const { success, filePath, error } = validateAndResolveFile(file);
    if (!success) {
      return sendError(res, filePath ? 400 : 404, error);
    }

    // Check if file should be forced to download (executable files)
    const { requiresDownload } = validateFileUpload(file.mimeType, file.name);

    res.type(file.mimeType);

    // Force download for potentially executable files to prevent execution in browser
    if (requiresDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    res.sendFile(filePath);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function renameFileController(req, res) {
  try {
    const { id, name } = req.body;
    const validatedId = validateId(id);
    if (!validatedId) {
      return sendError(res, 400, 'Invalid file ID');
    }
    if (!name || !validateFileName(name)) {
      return sendError(res, 400, 'Invalid file name');
    }
    const file = await renameFile(validatedId, name, req.userId);
    if (!file) {
      return sendError(res, 404, 'Not found');
    }
    sendSuccess(res, file);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

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
    await setStarred(validatedIds, validatedStarred, req.userId);
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

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
      
      const links = {};
      
      if (validatedShared) {
        for (const id of validatedIds) {
          const treeIds = await getRecursiveIds([id], req.userId);
          let token = await getShareLink(id, req.userId);
          if (!token) {
            token = await createShareLink(id, req.userId, treeIds);
          } else {
            await addFilesToShare(token, treeIds);
          }
          links[id] = token;
        }
        await setShared(validatedIds, true, req.userId);
      } else {
        const treeIds = await getRecursiveIds(validatedIds, req.userId);
        await removeFilesFromShares(treeIds, req.userId);
        for (const id of validatedIds) {
          await deleteShareLink(id, req.userId);
        }
        await setShared(validatedIds, false, req.userId);
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

async function linkParentShareController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    const links = {};
    for (const id of validatedIds) {
      const parentRes = await pool.query(
        'SELECT parent_id FROM files WHERE id = $1 AND user_id = $2',
        [id, req.userId]
      );
      const parentId = parentRes.rows[0]?.parent_id;
      if (!parentId) continue;
      const shareId = await getShareLink(parentId, req.userId);
      if (!shareId) continue;
      const treeIds = await getRecursiveIds([id], req.userId);
      await addFilesToShare(shareId, treeIds);
      await setShared([id], true, req.userId);
      links[id] = shareId;
    }
    sendSuccess(res, { success: true, links });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

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

async function deleteFilesController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    await deleteFiles(validatedIds, req.userId);
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

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

async function deleteForeverController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }
    await permanentlyDeleteFiles(validatedIds, req.userId);
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function searchFilesController(req, res) {
  try {
    const query = req.query.q || req.query.query || '';
    const validatedQuery = validateSearchQuery(query);
    if (!validatedQuery) {
      return sendError(res, 400, 'Invalid search query');
    }
    const limit = validateLimit(req.query.limit, 100) || 100;

    const files = await searchFiles(req.userId, validatedQuery, limit);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function getFileStatsController(req, res) {
  try {
    const stats = await getFileStats(req.userId);
    sendSuccess(res, stats);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  listFiles,
  addFolder,
  uploadFile,
  moveFiles: moveFilesController,
  copyFiles: copyFilesController,
  downloadFile,
  renameFile: renameFileController,
  starFiles: starFilesController,
  listStarred,
  shareFiles: shareFilesController,
  listShared,
  linkParentShare: linkParentShareController,
  deleteFiles: deleteFilesController,
  listTrash,
  deleteForever: deleteForeverController,
  searchFiles: searchFilesController,
  getFileStats: getFileStatsController,
};
