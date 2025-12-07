const { validateAndResolveFile } = require('../utils/fileDownload');
const { sendError, sendSuccess } = require('../utils/response');
const { createZipArchive } = require('../utils/zipArchive');
const { logger } = require('../config/logger');
const { logAuditEvent, fileUploaded, fileDownloaded, fileDeleted } = require('../services/auditLogger');
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
  getFolderTree,
  deleteFiles,
  getTrashFiles,
  restoreFiles,
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

    // Log folder creation
    await logAuditEvent('folder.create', {
      status: 'success',
      resourceType: 'folder',
      resourceId: folder.id,
      metadata: { folderName: name, parentId: validatedParentId }
    }, req);
    logger.info({ folderId: folder.id, name }, 'Folder created');

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

    // Log file upload
    await fileUploaded(file.id, file.name, file.size, req);
    logger.info({ fileId: file.id, fileName: file.name, fileSize: file.size }, 'File uploaded');

    sendSuccess(res, file);
  } catch (err) {
    // Log upload failure
    await logAuditEvent('file.upload', {
      status: 'error',
      errorMessage: err.message,
      metadata: { fileName: req.file?.originalname }
    }, req);
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

    // Get file and target folder names for audit logging
    const fileInfoResult = await pool.query(
      'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    let targetFolderName = 'Root';
    if (validatedParentId) {
      const targetResult = await pool.query(
        'SELECT name FROM files WHERE id = $1 AND user_id = $2',
        [validatedParentId, req.userId]
      );
      if (targetResult.rows[0]) {
        targetFolderName = targetResult.rows[0].name;
      }
    }

    await userOperationLock(req.userId, async () => {
      await moveFiles(validatedIds, validatedParentId, req.userId);
    });

    // Log file move with details
    await logAuditEvent('file.move', {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0],
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames: fileNames,
        fileTypes: fileTypes,
        targetParentId: validatedParentId,
        targetFolderName: targetFolderName,
      }
    }, req);
    logger.info({ fileIds: validatedIds, fileNames, targetFolderName }, 'Files moved');

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

    // Get file and target folder names for audit logging
    const fileInfoResult = await pool.query(
      'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    let targetFolderName = 'Root';
    if (validatedParentId) {
      const targetResult = await pool.query(
        'SELECT name FROM files WHERE id = $1 AND user_id = $2',
        [validatedParentId, req.userId]
      );
      if (targetResult.rows[0]) {
        targetFolderName = targetResult.rows[0].name;
      }
    }

    await userOperationLock(req.userId, async () => {
      await copyFiles(validatedIds, validatedParentId, req.userId);
    });

    // Log file copy with details
    await logAuditEvent('file.copy', {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0],
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames: fileNames,
        fileTypes: fileTypes,
        targetParentId: validatedParentId,
        targetFolderName: targetFolderName,
      }
    }, req);
    logger.info({ fileIds: validatedIds, fileNames, targetFolderName }, 'Files copied');

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

    // If it's a folder, zip it first
    if (file.type === 'folder') {
      await logAuditEvent('folder.download', {
        status: 'success',
        resourceType: 'folder',
        resourceId: fileId,
        metadata: { folderName: file.name }
      }, req);
      logger.info({ folderId: fileId, name: file.name }, 'Folder downloaded (zipped)');

      return await userOperationLock(req.userId, async () => {
        const entries = await getFolderTree(fileId, req.userId);
        createZipArchive(res, file.name, entries, fileId, file.name);
      });
    }

    // For files, download directly
    const { success, filePath, error } = validateAndResolveFile(file);
    if (!success) {
      return sendError(res, filePath ? 400 : 404, error);
    }

    // Log file download
    await fileDownloaded(fileId, file.name, req);
    logger.info({ fileId, fileName: file.name }, 'File downloaded');

    // Check if file should be forced to download (executable files)
    const { requiresDownload } = validateFileUpload(file.mimeType, file.name);

    res.type(file.mimeType);

    // Always set Content-Disposition to ensure correct filename with extension
    // Use RFC 5987 encoding for filenames with special characters
    const encodedFilename = encodeURIComponent(file.name);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"; filename*=UTF-8''${encodedFilename}`);

    // Force download for potentially executable files to prevent execution in browser
    if (requiresDownload) {
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

    // Log file rename
    await logAuditEvent('file.rename', {
      status: 'success',
      resourceType: file.type,
      resourceId: validatedId,
      metadata: { newName: name, oldName: file.name }
    }, req);
    logger.info({ fileId: validatedId, newName: name }, 'File renamed');

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

    // Get file names for audit logging
    const fileInfoResult = await pool.query(
      'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    await setStarred(validatedIds, validatedStarred, req.userId);

    // Log star/unstar with file details
    await logAuditEvent(validatedStarred ? 'file.star' : 'file.unstar', {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0], // First file ID
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames: fileNames,
        fileTypes: fileTypes,
        starred: validatedStarred,
      }
    }, req);
    logger.debug({ fileIds: validatedIds, fileNames, starred: validatedStarred }, 'Files starred status changed');

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
          const isNewShare = !token;
          if (!token) {
            token = await createShareLink(id, req.userId, treeIds);
          } else {
            await addFilesToShare(token, treeIds);
          }
          links[id] = token;

          // Log audit event for share creation
          if (isNewShare) {
            await logAuditEvent('share.create', {
              status: 'success',
              resourceType: 'share',
              resourceId: token,
              metadata: {
                fileId: id,
                fileCount: treeIds.length,
              },
            }, req);
            logger.info({ fileId: id, shareToken: token, fileCount: treeIds.length }, 'Share link created');
          }
        }
        await setShared(validatedIds, true, req.userId);
      } else {
        const treeIds = await getRecursiveIds(validatedIds, req.userId);
        await removeFilesFromShares(treeIds, req.userId);
        for (const id of validatedIds) {
          await deleteShareLink(id, req.userId);

          // Log audit event for share deletion
          await logAuditEvent('share.delete', {
            status: 'success',
            resourceType: 'share',
            resourceId: id,
            metadata: {
              fileId: id,
            },
          }, req);
          logger.info({ fileId: id }, 'Share link deleted');
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

    // Get file names for audit logging
    const fileInfoResult = await pool.query(
      'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    await deleteFiles(validatedIds, req.userId);

    // Log file deletion (soft delete to trash) with details
    await logAuditEvent('file.delete', {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0],
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames: fileNames,
        fileTypes: fileTypes,
        permanent: false,
      }
    }, req);
    logger.info({ fileIds: validatedIds, fileNames }, 'Files moved to trash');

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

    // Get file names for audit logging (from trash)
    const fileInfoResult = await pool.query(
      'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NOT NULL',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    await permanentlyDeleteFiles(validatedIds, req.userId);

    // Log permanent deletion with details
    await logAuditEvent('file.delete.permanent', {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0],
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames: fileNames,
        fileTypes: fileTypes,
        permanent: true,
      }
    }, req);
    logger.info({ fileIds: validatedIds, fileNames }, 'Files permanently deleted');

    sendSuccess(res, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function restoreFilesController(req, res) {
  try {
    const { ids } = req.body;
    const validatedIds = validateIdArray(ids);
    if (!validatedIds) {
      return sendError(res, 400, 'Invalid ids array');
    }

    // Get file names for audit logging (from trash)
    const fileInfoResult = await pool.query(
      'SELECT id, name, type FROM files WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NOT NULL',
      [validatedIds, req.userId]
    );
    const fileInfo = fileInfoResult.rows.map(f => ({ id: f.id, name: f.name, type: f.type }));
    const fileNames = fileInfo.map(f => f.name);
    const fileTypes = fileInfo.map(f => f.type);

    if (fileInfo.length === 0) {
      return sendError(res, 404, 'No files found in trash to restore');
    }

    await restoreFiles(validatedIds, req.userId);

    // Log file restore with details
    await logAuditEvent('file.restore', {
      status: 'success',
      resourceType: fileTypes[0] || 'file', // Use actual type (file/folder)
      resourceId: validatedIds[0],
      metadata: {
        fileCount: validatedIds.length,
        fileIds: validatedIds,
        fileNames: fileNames,
        fileTypes: fileTypes,
      }
    }, req);
    logger.info({ fileIds: validatedIds, fileNames }, 'Files restored from trash');

    sendSuccess(res, { success: true, message: `Restored ${fileInfo.length} file(s) from trash` });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function emptyTrashController(req, res) {
  try {
    // Get all trash files for the user
    const trashFiles = await getTrashFiles(req.userId);
    
    if (trashFiles.length === 0) {
      return sendSuccess(res, { success: true, message: 'Trash is already empty' });
    }

    const allIds = trashFiles.map(f => f.id);
    const fileNames = trashFiles.map(f => f.name);
    const fileTypes = trashFiles.map(f => f.type);

    await permanentlyDeleteFiles(allIds, req.userId);

    // Log empty trash action with details
    await logAuditEvent('file.delete.permanent', {
      status: 'success',
      resourceType: 'file',
      resourceId: allIds[0] || null,
      metadata: {
        fileCount: allIds.length,
        fileIds: allIds,
        fileNames: fileNames,
        fileTypes: fileTypes,
        permanent: true,
        action: 'empty_trash',
      }
    }, req);
    logger.info({ fileCount: allIds.length, fileNames }, 'Trash emptied');

    sendSuccess(res, { success: true, message: `Deleted ${allIds.length} file(s) from trash` });
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
        links[id] = token;
      }
    }

    sendSuccess(res, { success: true, links });
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
  getShareLinks: getShareLinksController,
  listShared,
  linkParentShare: linkParentShareController,
  deleteFiles: deleteFilesController,
  listTrash,
  restoreFiles: restoreFilesController,
  deleteForever: deleteForeverController,
  emptyTrash: emptyTrashController,
  searchFiles: searchFilesController,
  getFileStats: getFileStatsController,
};
