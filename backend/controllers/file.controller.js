const path = require('path');
const fs = require('fs');
const { UPLOAD_DIR } = require('../config/paths');
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
  const parentId = req.query.parentId || null;
  try {
    const files = await getFiles(req.userId, parentId);
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function addFolder(req, res) {
  const { name, parentId = null } = req.body;
  if (!name) return res.status(400).json({ message: 'Name required' });
  try {
    const folder = await createFolder(name, parentId, req.userId);
    res.json(folder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function uploadFile(req, res) {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  const parentId = req.body.parentId || null;
  try {
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
    res.json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function moveFilesController(req, res) {
  const { ids, parentId = null } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids required' });
  }
  try {
    await userOperationLock(req.userId, async () => {
      await moveFiles(ids, parentId, req.userId);
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function copyFilesController(req, res) {
  const { ids, parentId = null } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids required' });
  }
  try {
    await userOperationLock(req.userId, async () => {
      await copyFiles(ids, parentId, req.userId);
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function downloadFile(req, res) {
  try {
    const file = await getFile(req.params.id, req.userId);
    if (!file) return res.status(404).json({ message: 'File not found' });
    
    // Validate file path to prevent path traversal
    if (!file.path || file.path.includes('..') || file.path.includes('/') || file.path.includes('\\')) {
      return res.status(400).json({ message: 'Invalid file path' });
    }
    
    const uploadsDir = UPLOAD_DIR;
    const filePath = path.join(uploadsDir, file.path);
    
    // Ensure the resolved path is within uploads directory
    if (!filePath.startsWith(uploadsDir)) {
      return res.status(400).json({ message: 'Invalid file path' });
    }
    
    // Check if file exists
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'File not found on disk' });
    }
    
    res.type(file.mimeType);
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function renameFileController(req, res) {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ message: 'id and name required' });
  try {
    const file = await renameFile(id, name, req.userId);
    if (!file) return res.status(404).json({ message: 'Not found' });
    res.json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function starFilesController(req, res) {
  const { ids, starred } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || typeof starred !== 'boolean') {
    return res.status(400).json({ message: 'ids and starred required' });
  }
  try {
    await setStarred(ids, starred, req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function shareFilesController(req, res) {
  const { ids, shared } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || typeof shared !== 'boolean') {
    return res.status(400).json({ message: 'ids and shared required' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const affected = await setShared(ids, shared, req.userId);
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
    res.json({ success: true, links });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
}

async function linkParentShareController(req, res) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids required' });
  }
  try {
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
    res.json({ success: true, links });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function listStarred(req, res) {
  try {
    const files = await getStarredFiles(req.userId);
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function listShared(req, res) {
  try {
    const files = await getSharedFiles(req.userId);
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function deleteFilesController(req, res) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids required' });
  }
  try {
    await deleteFiles(ids, req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function listTrash(req, res) {
  try {
    const files = await getTrashFiles(req.userId);
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function deleteForeverController(req, res) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids required' });
  }
  try {
    await permanentlyDeleteFiles(ids, req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
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
};
