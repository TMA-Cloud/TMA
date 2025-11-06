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

async function listFiles(req, res) {
  try {
    const parentId = req.query.parentId || null;
    const sortBy = req.query.sortBy;
    const order = req.query.order;
    const files = await getFiles(req.userId, parentId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function addFolder(req, res) {
  try {
    const { name, parentId = null } = req.body;
    if (!name) {
      return sendError(res, 400, 'Name required');
    }
    const folder = await createFolder(name, parentId, req.userId);
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
    const parentId = req.body.parentId || null;
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
    if (!Array.isArray(ids) || ids.length === 0) {
      return sendError(res, 400, 'ids required');
    }
    await userOperationLock(req.userId, async () => {
      await moveFiles(ids, parentId, req.userId);
    });
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function copyFilesController(req, res) {
  try {
    const { ids, parentId = null } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return sendError(res, 400, 'ids required');
    }
    await userOperationLock(req.userId, async () => {
      await copyFiles(ids, parentId, req.userId);
    });
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function downloadFile(req, res) {
  try {
    const file = await getFile(req.params.id, req.userId);
    if (!file) {
      return sendError(res, 404, 'File not found');
    }
    
    const { success, filePath, error } = validateAndResolveFile(file);
    if (!success) {
      return sendError(res, filePath ? 400 : 404, error);
    }
    
    res.type(file.mimeType);
    res.sendFile(filePath);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function renameFileController(req, res) {
  try {
    const { id, name } = req.body;
    if (!id || !name) {
      return sendError(res, 400, 'id and name required');
    }
    const file = await renameFile(id, name, req.userId);
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
    if (!Array.isArray(ids) || ids.length === 0 || typeof starred !== 'boolean') {
      return sendError(res, 400, 'ids and starred required');
    }
    await setStarred(ids, starred, req.userId);
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function shareFilesController(req, res) {
  const { ids, shared } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || typeof shared !== 'boolean') {
    return sendError(res, 400, 'ids and shared required');
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const links = {};
    
    if (shared) {
      for (const id of ids) {
        const treeIds = await getRecursiveIds([id], req.userId);
        let token = await getShareLink(id, req.userId);
        if (!token) {
          token = await createShareLink(id, req.userId, treeIds);
        } else {
          await addFilesToShare(token, treeIds);
        }
        links[id] = token;
      }
    } else {
      const treeIds = await getRecursiveIds(ids, req.userId);
      await removeFilesFromShares(treeIds, req.userId);
      for (const id of ids) {
        await deleteShareLink(id, req.userId);
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
}

async function linkParentShareController(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return sendError(res, 400, 'ids required');
    }
    const links = {};
    for (const id of ids) {
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
    const sortBy = req.query.sortBy;
    const order = req.query.order;
    const files = await getStarredFiles(req.userId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function listShared(req, res) {
  try {
    const sortBy = req.query.sortBy;
    const order = req.query.order;
    const files = await getSharedFiles(req.userId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function deleteFilesController(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return sendError(res, 400, 'ids required');
    }
    await deleteFiles(ids, req.userId);
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function listTrash(req, res) {
  try {
    const sortBy = req.query.sortBy;
    const order = req.query.order;
    const files = await getTrashFiles(req.userId, sortBy, order);
    sendSuccess(res, files);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function deleteForeverController(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return sendError(res, 400, 'ids required');
    }
    await permanentlyDeleteFiles(ids, req.userId);
    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function searchFilesController(req, res) {
  try {
    const query = req.query.q || req.query.query || '';
    const limit = parseInt(req.query.limit, 10) || 100;

    if (!query || query.trim().length === 0) {
      return sendError(res, 400, 'Search query required');
    }

    const files = await searchFiles(req.userId, query, limit);
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
