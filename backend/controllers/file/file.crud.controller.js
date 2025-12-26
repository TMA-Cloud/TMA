const { validateAndResolveFile } = require('../../utils/fileDownload');
const { sendError, sendSuccess } = require('../../utils/response');
const { createZipArchive } = require('../../utils/zipArchive');
const { logger } = require('../../config/logger');
const { logAuditEvent, fileUploaded, fileDownloaded } = require('../../services/auditLogger');
const { publishFileEvent, EventTypes } = require('../../services/fileEvents');
const {
  getFiles,
  createFolder,
  createFile,
  getFile,
  renameFile: renameFileModel,
  getFolderTree,
} = require('../../models/file.model');
const { userOperationLock } = require('../../utils/mutex');
const {
  validateId,
  validateFileName,
  validateSortBy,
  validateSortOrder,
  validateFileUpload,
} = require('../../utils/validation');

/**
 * List files in a directory
 */
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

/**
 * Create a new folder
 */
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
    await logAuditEvent(
      'folder.create',
      {
        status: 'success',
        resourceType: 'folder',
        resourceId: folder.id,
        metadata: { folderName: name, parentId: validatedParentId },
      },
      req
    );
    logger.info({ folderId: folder.id, name }, 'Folder created');

    // Publish folder created event
    await publishFileEvent(EventTypes.FOLDER_CREATED, {
      id: folder.id,
      name: folder.name,
      type: folder.type,
      parentId: validatedParentId,
      userId: req.userId,
    });

    sendSuccess(res, folder);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Upload a file
 */
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

    const file = await userOperationLock(req.userId, () => {
      return createFile(req.file.originalname, req.file.size, req.file.mimetype, req.file.path, parentId, req.userId);
    });

    // Log file upload
    await fileUploaded(file.id, file.name, file.size, req);
    logger.info({ fileId: file.id, fileName: file.name, fileSize: file.size }, 'File uploaded');

    // Publish file uploaded event
    await publishFileEvent(EventTypes.FILE_UPLOADED, {
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      mimeType: file.mimeType,
      parentId,
      userId: req.userId,
    });

    sendSuccess(res, file);
  } catch (err) {
    // Log upload failure
    await logAuditEvent(
      'file.upload',
      {
        status: 'error',
        errorMessage: err.message,
        metadata: { fileName: req.file?.originalname },
      },
      req
    );
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Download a file or folder
 */
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
      await logAuditEvent(
        'folder.download',
        {
          status: 'success',
          resourceType: 'folder',
          resourceId: fileId,
          metadata: { folderName: file.name },
        },
        req
      );
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

/**
 * Rename a file or folder
 */
async function renameFile(req, res) {
  try {
    const { id, name } = req.body;
    const validatedId = validateId(id);
    if (!validatedId) {
      return sendError(res, 400, 'Invalid file ID');
    }
    if (!name || !validateFileName(name)) {
      return sendError(res, 400, 'Invalid file name');
    }
    const file = await renameFileModel(validatedId, name, req.userId);
    if (!file) {
      return sendError(res, 404, 'Not found');
    }

    // Log file rename
    await logAuditEvent(
      'file.rename',
      {
        status: 'success',
        resourceType: file.type,
        resourceId: validatedId,
        metadata: { newName: name, oldName: file.name },
      },
      req
    );
    logger.info({ fileId: validatedId, newName: name }, 'File renamed');

    // Publish file renamed event
    await publishFileEvent(EventTypes.FILE_RENAMED, {
      id: validatedId,
      name,
      oldName: file.name,
      type: file.type,
      parentId: file.parentId || null,
      userId: req.userId,
    });

    sendSuccess(res, file);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  listFiles,
  addFolder,
  uploadFile,
  downloadFile,
  renameFile,
};
