const { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile } = require('../../utils/fileDownload');
const { sendError, sendSuccess } = require('../../utils/response');
const { createZipArchive, createBulkZipArchive } = require('../../utils/zipArchive');
const { logger } = require('../../config/logger');
const { logAuditEvent, fileUploaded, fileDownloaded } = require('../../services/auditLogger');
const { publishFileEvent, EventTypes } = require('../../services/fileEvents');
const {
  getFiles,
  createFolder,
  createFile,
  createFileFromStreamedUpload,
  getFile,
  getFilesByIds,
  renameFile: renameFileModel,
  getFolderTree,
} = require('../../models/file.model');
const { userOperationLock } = require('../../utils/mutex');
const { validateSortBy, validateSortOrder, validateFileUpload, validateFileName } = require('../../utils/validation');
const { validateParentId } = require('../../utils/controllerHelpers');
const { getUserStorageUsage, getUserStorageLimit } = require('../../models/user.model');
const { safeUnlink } = require('../../utils/fileCleanup');
const { validateMimeType } = require('../../utils/mimeTypeDetection');
const { checkStorageLimitExceeded } = require('../../utils/storageUtils');

/**
 * Check if an upload would exceed storage limit (call before starting upload).
 * Returns 200 { allowed: true } or 413 with message so the client can show error without uploading.
 */
async function checkUploadStorage(req, res) {
  const fileSize = Number(req.body.fileSize);
  if (!Number.isInteger(fileSize) || fileSize < 0) {
    return sendError(res, 400, 'fileSize must be a non-negative integer');
  }
  try {
    const used = await getUserStorageUsage(req.userId);
    const userStorageLimit = await getUserStorageLimit(req.userId);

    const checkResult = await checkStorageLimitExceeded({
      fileSize,
      used,
      userStorageLimit,
    });

    if (checkResult.exceeded) {
      return sendError(res, 413, checkResult.message);
    }
    return sendSuccess(res, { allowed: true });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Error checking upload storage');
    return sendError(res, 500, 'Unable to verify storage limit. Please try again.');
  }
}

/**
 * List files in a directory
 */
async function listFiles(req, res) {
  const { valid, parentId, error } = validateParentId(req, 'query');
  if (!valid) {
    return sendError(res, 400, error);
  }

  // listFiles only reads from database; no filesystem access
  const sortBy = validateSortBy(req.query.sortBy) || 'modified';
  const order = validateSortOrder(req.query.order) || 'DESC';
  const files = await getFiles(req.userId, parentId, sortBy, order);

  // IMPORTANT: Disable HTTP-level caching for dynamic file listings.
  // We already use Redis for caching and handle invalidation explicitly
  // (e.g. on rename, move, delete). Allowing the browser to cache this
  // response can lead to stale directory views where a renamed file
  // still appears under its old name until the tab or app is fully
  // reloaded. By turning off browser caching here, the client will
  // always get the latest view from our own cache/DB.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  sendSuccess(res, files);
}

/**
 * Create a new folder
 */
async function addFolder(req, res) {
  const { name, parentId } = req.body;
  const folder = await createFolder(name, parentId, req.userId);

  // Log folder creation
  await logAuditEvent(
    'folder.create',
    {
      status: 'success',
      resourceType: 'folder',
      resourceId: folder.id,
      metadata: { folderName: name, parentId },
    },
    req
  );
  logger.info({ folderId: folder.id, name }, 'Folder created');

  // Publish folder created event
  await publishFileEvent(EventTypes.FOLDER_CREATED, {
    id: folder.id,
    name: folder.name,
    type: folder.type,
    parentId,
    userId: req.userId,
  });

  sendSuccess(res, folder);
}

/**
 * Upload a file (multer disk/local or stream-to-S3 when S3 enabled)
 */
async function uploadFile(req, res) {
  // S3: streamed upload (no temp file)
  if (req.streamedUpload) {
    const upload = req.streamedUpload;
    if (!validateFileName(upload.name)) {
      return sendError(res, 400, 'Invalid file name');
    }
    validateFileUpload(upload.mimeType, upload.name);

    const { valid, parentId, error } = validateParentId(req);
    if (!valid) {
      return sendError(res, 400, error);
    }

    const file = await userOperationLock(req.userId, () => {
      return createFileFromStreamedUpload(upload, parentId, req.userId);
    });

    await fileUploaded(file.id, file.name, file.size, req);
    logger.info({ fileId: file.id, fileName: file.name, fileSize: file.size }, 'File uploaded (stream to S3)');
    await publishFileEvent(EventTypes.FILE_UPLOADED, {
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      mimeType: file.mimeType,
      parentId,
      userId: req.userId,
    });
    return sendSuccess(res, file);
  }

  if (!req.file) {
    return sendError(res, 400, 'No file uploaded');
  }

  if (!validateFileName(req.file.originalname)) {
    return sendError(res, 400, 'Invalid file name');
  }

  let actualMimeType = req.file.mimetype || 'application/octet-stream';
  const mimeValidation = await validateMimeType(req.file.path, req.file.mimetype, req.file.originalname);
  if (!mimeValidation.valid) {
    await safeUnlink(req.file.path);
    return sendError(res, 400, mimeValidation.error || 'Invalid file type');
  }
  actualMimeType = mimeValidation.actualMimeType || req.file.mimetype || 'application/octet-stream';

  validateFileUpload(actualMimeType, req.file.originalname);

  const { valid, parentId, error } = validateParentId(req);
  if (!valid) {
    await safeUnlink(req.file.path);
    return sendError(res, 400, error);
  }

  try {
    const used = await getUserStorageUsage(req.userId);
    const userStorageLimit = await getUserStorageLimit(req.userId);
    const checkResult = await checkStorageLimitExceeded({
      fileSize: req.file.size,
      used,
      userStorageLimit,
    });

    if (checkResult.exceeded) {
      await safeUnlink(req.file.path);
      return sendError(res, 413, checkResult.message);
    }
  } catch (storageError) {
    logger.error({ err: storageError, userId: req.userId }, 'Error checking storage limit');
    await safeUnlink(req.file.path);
    return sendError(res, 500, 'Unable to verify storage limit. Please try again.');
  }

  const file = await userOperationLock(req.userId, () => {
    return createFile(req.file.originalname, req.file.size, actualMimeType, req.file.path, parentId, req.userId);
  });

  await fileUploaded(file.id, file.name, file.size, req);
  logger.info({ fileId: file.id, fileName: file.name, fileSize: file.size }, 'File uploaded');

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
}

/**
 * Replace contents of an existing file (used by desktop editor integration)
 */
async function replaceFileContents(req, res) {
  const fileId = req.params.id;

  if (!req.file) {
    return sendError(res, 400, 'No file uploaded');
  }

  try {
    const existing = await getFile(fileId, req.userId);
    if (!existing) {
      await safeUnlink(req.file.path);
      return sendError(res, 404, 'File not found');
    }

    if (!validateFileName(existing.name)) {
      await safeUnlink(req.file.path);
      return sendError(res, 400, 'Invalid file name');
    }

    let actualMimeType = req.file.mimetype || 'application/octet-stream';
    const mimeValidation = await validateMimeType(req.file.path, req.file.mimetype, existing.name);
    if (!mimeValidation.valid) {
      await safeUnlink(req.file.path);
      return sendError(res, 400, mimeValidation.error || 'Invalid file type');
    }
    actualMimeType = mimeValidation.actualMimeType || req.file.mimetype || 'application/octet-stream';

    validateFileUpload(actualMimeType, existing.name);

    const updated = await require('../../models/file.model').replaceFileData(
      fileId,
      req.file.size,
      actualMimeType,
      req.file.path,
      req.userId
    );

    if (!updated) {
      return sendError(res, 404, 'File not found');
    }

    await logAuditEvent(
      'file.update',
      {
        status: 'success',
        resourceType: updated.type,
        resourceId: updated.id,
        metadata: {
          fileName: updated.name,
          size: updated.size,
        },
      },
      req
    );
    logger.info({ fileId, fileName: updated.name }, 'File contents updated');

    await publishFileEvent(EventTypes.FILE_UPDATED, {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      size: updated.size,
      mimeType: updated.mimeType,
      parentId: updated.parentId || null,
      userId: req.userId,
    });

    return sendSuccess(res, updated);
  } catch (err) {
    logger.error({ err, fileId }, 'Error replacing file contents');
    if (req.file?.path) {
      try {
        await safeUnlink(req.file.path);
      } catch (_) {
        // ignore
      }
    }
    return sendError(res, 500, 'Failed to update file');
  }
}

/**
 * Bulk upload multiple files (multer disk/local or stream-to-S3 when S3 enabled)
 */
async function uploadFilesBulk(req, res) {
  // S3: streamed uploads (no temp files)
  if (req.streamedUploads) {
    const uploads = req.streamedUploads;
    if (uploads.length === 0) {
      return sendError(res, 400, 'No files uploaded');
    }

    for (const u of uploads) {
      if (!validateFileName(u.name)) {
        return sendError(res, 400, `Invalid file name: ${u.name}`);
      }
      validateFileUpload(u.mimeType, u.name);
    }

    const { valid, parentId, error } = validateParentId(req);
    if (!valid) {
      return sendError(res, 400, error);
    }

    const successful = [];
    const failed = [];

    for (const upload of uploads) {
      try {
        const file = await userOperationLock(req.userId, () => {
          return createFileFromStreamedUpload(upload, parentId, req.userId);
        });
        await fileUploaded(file.id, file.name, file.size, req);
        logger.info({ fileId: file.id, fileName: file.name }, 'File uploaded (stream to S3)');
        await publishFileEvent(EventTypes.FILE_UPLOADED, {
          id: file.id,
          name: file.name,
          type: file.type,
          size: file.size,
          mimeType: file.mimeType,
          parentId,
          userId: req.userId,
        });
        successful.push(file);
      } catch (err) {
        failed.push({ fileName: upload.name, error: err?.message || 'Upload failed' });
      }
    }

    if (successful.length === 0) {
      return sendError(res, 400, failed[0]?.error || 'All uploads failed');
    }

    return sendSuccess(res, {
      files: successful,
      failed: failed.length > 0 ? failed : undefined,
      total: uploads.length,
      successful: successful.length,
      failedCount: failed.length,
    });
  }

  if (!req.files || req.files.length === 0) {
    return sendError(res, 400, 'No files uploaded');
  }

  for (const file of req.files) {
    if (!validateFileName(file.originalname)) {
      for (const f of req.files) {
        await safeUnlink(f.path);
      }
      return sendError(res, 400, `Invalid file name: ${file.originalname}`);
    }
  }

  const { valid, parentId, error } = validateParentId(req);
  if (!valid) {
    for (const file of req.files) {
      await safeUnlink(file.path);
    }
    return sendError(res, 400, error);
  }

  const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
  try {
    const used = await getUserStorageUsage(req.userId);
    const userStorageLimit = await getUserStorageLimit(req.userId);
    const checkResult = await checkStorageLimitExceeded({
      fileSize: totalSize,
      used,
      userStorageLimit,
    });

    if (checkResult.exceeded) {
      for (const file of req.files) {
        await safeUnlink(file.path);
      }
      return sendError(res, 413, checkResult.message);
    }
  } catch (storageError) {
    logger.error({ err: storageError, userId: req.userId }, 'Error checking storage limit');
    for (const file of req.files) {
      await safeUnlink(file.path);
    }
    return sendError(res, 500, 'Unable to verify storage limit. Please try again.');
  }

  const uploadPromises = req.files.map(async file => {
    let actualMimeType = file.mimetype || 'application/octet-stream';
    const mimeValidation = await validateMimeType(file.path, file.mimetype, file.originalname);
    if (!mimeValidation.valid) {
      await safeUnlink(file.path);
      throw new Error(`Invalid file type: ${file.originalname}`);
    }
    actualMimeType = mimeValidation.actualMimeType || file.mimetype || 'application/octet-stream';

    validateFileUpload(actualMimeType, file.originalname);

    try {
      const createdFile = await userOperationLock(req.userId, () => {
        return createFile(file.originalname, file.size, actualMimeType, file.path, parentId, req.userId);
      });

      await fileUploaded(createdFile.id, createdFile.name, createdFile.size, req);
      logger.info({ fileId: createdFile.id, fileName: createdFile.name, fileSize: createdFile.size }, 'File uploaded');

      await publishFileEvent(EventTypes.FILE_UPLOADED, {
        id: createdFile.id,
        name: createdFile.name,
        type: createdFile.type,
        size: createdFile.size,
        mimeType: createdFile.mimeType,
        parentId,
        userId: req.userId,
      });

      return createdFile;
    } catch (error) {
      await safeUnlink(file.path);
      throw error;
    }
  });

  const results = await Promise.allSettled(uploadPromises);

  const successful = [];
  const failed = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      successful.push(result.value);
    } else {
      failed.push({
        fileName: req.files[i].originalname,
        error: result.reason?.message || 'Upload failed',
      });
    }
  }

  if (successful.length === 0) {
    return sendError(res, 400, failed.length > 0 ? failed[0].error : 'All uploads failed');
  }

  sendSuccess(res, {
    files: successful,
    failed: failed.length > 0 ? failed : undefined,
    total: req.files.length,
    successful: successful.length,
    failedCount: failed.length,
  });
}

/**
 * Download a file or folder
 */
async function downloadFile(req, res) {
  const { id: fileId } = req.params;

  const file = await getFile(fileId, req.userId);
  if (!file) {
    return sendError(res, 404, 'File not found');
  }

  // If it's a folder, zip it first
  if (file.type === 'folder') {
    try {
      return await userOperationLock(req.userId, async () => {
        const entries = await getFolderTree(fileId, req.userId);

        // Create zip archive - this will handle errors internally
        // We pass a callback to log success only after zip completes
        await createZipArchive(res, file.name, entries, fileId, file.name, async () => {
          // Log success only after zip is successfully created
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
        });
      });
    } catch (error) {
      if (!res.headersSent) {
        throw error;
      }
      logger.error({ folderId: fileId, error: error.message }, 'Error during folder download (headers already sent)');
    }
  }

  // For files, download directly (filePath for local, storageKey for S3)
  const { success, filePath, storageKey, isEncrypted, error: fileError } = await validateAndResolveFile(file);
  if (!success) {
    return sendError(res, filePath || storageKey ? 400 : 404, fileError);
  }

  const pathOrKey = filePath || storageKey;

  // Log file download
  await fileDownloaded(fileId, file.name, req);
  logger.info({ fileId, fileName: file.name }, 'File downloaded');

  // Check if file should be forced to download (executable files)
  const { requiresDownload } = validateFileUpload(file.mimeType, file.name);

  // Force download for potentially executable files to prevent execution in browser
  if (requiresDownload) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  // If file is encrypted, stream decrypted content
  if (isEncrypted) {
    return streamEncryptedFile(res, pathOrKey, file.name, file.mimeType);
  }

  // For unencrypted files, stream from path or S3
  return streamUnencryptedFile(res, pathOrKey, file.name, file.mimeType, true);
}

/**
 * Rename a file or folder
 */
async function renameFile(req, res) {
  const { name, id } = req.body;

  const file = await renameFileModel(id, name, req.userId);
  if (!file) {
    return sendError(res, 404, 'Not found');
  }

  await logAuditEvent(
    'file.rename',
    {
      status: 'success',
      resourceType: file.type,
      resourceId: id,
      metadata: { newName: name, oldName: file.name },
    },
    req
  );
  logger.info({ fileId: id, newName: name }, 'File renamed');

  await publishFileEvent(EventTypes.FILE_RENAMED, {
    id,
    name,
    oldName: file.name,
    type: file.type,
    parentId: file.parentId || null,
    userId: req.userId,
  });

  sendSuccess(res, file);
}

/**
 * Bulk download multiple files/folders as a single ZIP archive
 */
async function downloadFilesBulk(req, res) {
  const { ids } = req.body;

  try {
    return await userOperationLock(req.userId, async () => {
      // Get all files/folders to download in a single query (bulk operation)
      const filesToDownload = await getFilesByIds(ids, req.userId);

      if (filesToDownload.length === 0) {
        return sendError(res, 404, 'No files found to download');
      }

      // Get folder trees for all folders
      const allEntries = [];
      const rootIds = [];
      const fileNames = [];

      for (const file of filesToDownload) {
        fileNames.push(file.name);
        rootIds.push(file.id);

        if (file.type === 'folder') {
          const entries = await getFolderTree(file.id, req.userId);
          allEntries.push(...entries);
        } else {
          // Add the file itself to entries
          allEntries.push({
            id: file.id,
            name: file.name,
            type: file.type,
            path: file.path,
            parent_id: file.parentId || null,
          });
        }
      }

      // Create archive name from first file/folder name, or use "download" if multiple
      const archiveName = filesToDownload.length === 1 ? filesToDownload[0].name : `download_${Date.now()}`;

      // Create zip archive - this will handle errors internally
      await createBulkZipArchive(res, archiveName, allEntries, rootIds, async () => {
        // Log success only after zip is successfully created
        await logAuditEvent(
          'file.download.bulk',
          {
            status: 'success',
            resourceType: 'file',
            resourceId: ids[0],
            metadata: {
              fileCount: ids.length,
              fileIds: ids,
              fileNames,
            },
          },
          req
        );
        logger.info({ fileIds: ids, fileNames, count: ids.length }, 'Files downloaded (bulk zip)');
      });
    });
  } catch (error) {
    if (!res.headersSent) {
      throw error;
    }
    logger.error({ fileIds: ids, error: error.message }, 'Error during bulk download (headers already sent)');
  }
}

module.exports = {
  listFiles,
  addFolder,
  checkUploadStorage,
  uploadFile,
  uploadFilesBulk,
  downloadFile,
  downloadFilesBulk,
  renameFile,
  replaceFileContents,
};
