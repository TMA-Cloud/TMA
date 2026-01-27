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
  getFile,
  getFilesByIds,
  renameFile: renameFileModel,
  getFolderTree,
} = require('../../models/file.model');
const { userOperationLock } = require('../../utils/mutex');
const { validateSortBy, validateSortOrder, validateFileUpload, validateFileName } = require('../../utils/validation');
const { validateParentId } = require('../../utils/controllerHelpers');
const { getUserStorageUsage, getUserStorageLimit } = require('../../models/user.model');
const { getUserCustomDrive } = require('../../models/file/file.cache.model');
const { safeUnlink } = require('../../utils/fileCleanup');
const { validateMimeType } = require('../../utils/mimeTypeDetection');
const { checkAgentForUser } = require('../../utils/agentCheck');
const { AGENT_OFFLINE_MESSAGE, AGENT_OFFLINE_STATUS } = require('../../utils/agentConstants');
const { isAgentOfflineError } = require('../../utils/agentErrorDetection');

// Helper function to check agent and return error if offline
async function requireAgentOnline(req) {
  const agentCheck = await checkAgentForUser(req.userId);
  if (agentCheck.required && !agentCheck.online) {
    return { error: true, status: AGENT_OFFLINE_STATUS, message: AGENT_OFFLINE_MESSAGE };
  }
  return { error: false, agentCheck };
}

/**
 * List files in a directory
 */
async function listFiles(req, res) {
  const { valid, parentId, error } = validateParentId(req, 'query');
  if (!valid) {
    return sendError(res, 400, error);
  }

  // Note: listFiles only reads from database - no agent check needed
  // Agent check is only required for filesystem operations (download, upload, rename, delete, etc.)
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
 * Upload a file
 */
async function uploadFile(req, res) {
  if (!req.file) {
    return sendError(res, 400, 'No file uploaded');
  }

  // Validate filename
  if (!validateFileName(req.file.originalname)) {
    return sendError(res, 400, 'Invalid file name');
  }

  // Detect and validate actual MIME type from file content (prevents MIME spoofing)
  // For custom drive files streamed directly, MIME type is already detected from stream
  let actualMimeType = req.file.mimetype || 'application/octet-stream';

  // Only validate MIME type if file is in UPLOAD_DIR (not already in custom drive)
  if (req.file.path && !req.file.customDriveFinalPath) {
    const mimeValidation = await validateMimeType(req.file.path, req.file.mimetype, req.file.originalname);
    if (!mimeValidation.valid) {
      await safeUnlink(req.file.path);
      return sendError(res, 400, mimeValidation.error || 'Invalid file type');
    }
    actualMimeType = mimeValidation.actualMimeType || req.file.mimetype || 'application/octet-stream';
  }

  // Validate for security concerns (executable files, etc.)
  validateFileUpload(actualMimeType, req.file.originalname);

  const { valid, parentId, error } = validateParentId(req);
  if (!valid) {
    if (req.file.path && !req.file.customDriveFinalPath) {
      await safeUnlink(req.file.path);
    } else if (req.file.customDriveFinalPath) {
      // File is in custom drive, delete via agent
      const { agentDeletePath } = require('../../utils/agentFileOperations');
      await agentDeletePath(req.file.customDriveFinalPath).catch(() => {});
    }
    return sendError(res, 400, error);
  }

  // Check if agent is required - STRICT: block if agent is not confirmed online
  const agentResult = await requireAgentOnline(req);
  if (agentResult.error) {
    if (req.file.path && !req.file.customDriveFinalPath) {
      await safeUnlink(req.file.path);
    } else if (req.file.customDriveFinalPath) {
      // File is in custom drive, delete via agent
      const { agentDeletePath } = require('../../utils/agentFileOperations');
      await agentDeletePath(req.file.customDriveFinalPath).catch(() => {});
    }
    return sendError(res, agentResult.status, agentResult.message);
  }

  // Final safeguard: Check storage limit with actual file size
  // (Middleware checks using Content-Length estimate, this uses actual size for accuracy)
  try {
    // Use cached version for efficiency (O(1) with cache hit)
    const customDrive = await getUserCustomDrive(req.userId);
    const used = await getUserStorageUsage(req.userId);
    const basePath = process.env.UPLOAD_DIR || __dirname;
    const userStorageLimit = await getUserStorageLimit(req.userId);
    const { checkStorageLimitExceeded } = require('../../utils/storageUtils');

    const checkResult = await checkStorageLimitExceeded({
      fileSize: req.file.size,
      customDrive,
      used,
      userStorageLimit,
      defaultBasePath: basePath,
    });

    if (checkResult.exceeded) {
      if (req.file.path && !req.file.customDriveFinalPath) {
        await safeUnlink(req.file.path);
      } else if (req.file.customDriveFinalPath) {
        // File is in custom drive, delete via agent
        const { agentDeletePath } = require('../../utils/agentFileOperations');
        await agentDeletePath(req.file.customDriveFinalPath).catch(() => {});
      }
      return sendError(res, 413, checkResult.message);
    }
  } catch (storageError) {
    logger.error({ err: storageError, userId: req.userId }, 'Error checking storage limit');
    if (req.file.path && !req.file.customDriveFinalPath) {
      await safeUnlink(req.file.path);
    } else if (req.file.customDriveFinalPath) {
      // File is in custom drive, delete via agent
      const { agentDeletePath } = require('../../utils/agentFileOperations');
      await agentDeletePath(req.file.customDriveFinalPath).catch(() => {});
    }
    return sendError(res, 500, 'Unable to verify storage limit. Please try again.');
  }

  const file = await userOperationLock(req.userId, () => {
    // Pass customDriveFinalPath flag to indicate file is already in final location
    return createFile(
      req.file.originalname,
      req.file.size,
      actualMimeType,
      req.file.path,
      parentId,
      req.userId,
      req.file.customDriveFinalPath
    );
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
}

/**
 * Bulk upload multiple files
 */
async function uploadFilesBulk(req, res) {
  if (!req.files || req.files.length === 0) {
    return sendError(res, 400, 'No files uploaded');
  }

  // Validate all filenames
  for (const file of req.files) {
    if (!validateFileName(file.originalname)) {
      // Clean up all uploaded files
      for (const f of req.files) {
        if (f.path && !f.customDriveFinalPath) {
          await safeUnlink(f.path);
        } else if (f.customDriveFinalPath) {
          const { agentDeletePath } = require('../../utils/agentFileOperations');
          await agentDeletePath(f.customDriveFinalPath).catch(() => {});
        }
      }
      return sendError(res, 400, `Invalid file name: ${file.originalname}`);
    }
  }

  // Validate parentId (same for all files)
  const { valid, parentId, error } = validateParentId(req);
  if (!valid) {
    // Clean up all uploaded files
    for (const file of req.files) {
      if (file.path && !file.customDriveFinalPath) {
        await safeUnlink(file.path);
      } else if (file.customDriveFinalPath) {
        const { agentDeletePath } = require('../../utils/agentFileOperations');
        await agentDeletePath(file.customDriveFinalPath).catch(() => {});
      }
    }
    return sendError(res, 400, error);
  }

  // Check if agent is required - STRICT: block if agent is not confirmed online
  const agentResult = await requireAgentOnline(req);
  if (agentResult.error) {
    // Clean up all uploaded files
    for (const file of req.files) {
      if (file.path && !file.customDriveFinalPath) {
        await safeUnlink(file.path);
      } else if (file.customDriveFinalPath) {
        const { agentDeletePath } = require('../../utils/agentFileOperations');
        await agentDeletePath(file.customDriveFinalPath).catch(() => {});
      }
    }
    return sendError(res, agentResult.status, agentResult.message);
  }

  // Calculate total size and check storage limit
  const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
  try {
    // Use cached version for efficiency (O(1) with cache hit)
    const customDrive = await getUserCustomDrive(req.userId);
    const used = await getUserStorageUsage(req.userId);
    const basePath = process.env.UPLOAD_DIR || __dirname;
    const userStorageLimit = await getUserStorageLimit(req.userId);
    const { checkStorageLimitExceeded } = require('../../utils/storageUtils');

    const checkResult = await checkStorageLimitExceeded({
      fileSize: totalSize,
      customDrive,
      used,
      userStorageLimit,
      defaultBasePath: basePath,
    });

    if (checkResult.exceeded) {
      // Clean up all uploaded files
      for (const file of req.files) {
        if (file.path && !file.customDriveFinalPath) {
          await safeUnlink(file.path);
        } else if (file.customDriveFinalPath) {
          const { agentDeletePath } = require('../../utils/agentFileOperations');
          await agentDeletePath(file.customDriveFinalPath).catch(() => {});
        }
      }
      return sendError(res, 413, checkResult.message);
    }
  } catch (storageError) {
    logger.error({ err: storageError, userId: req.userId }, 'Error checking storage limit');
    // Clean up all uploaded files
    for (const file of req.files) {
      if (file.path && !file.customDriveFinalPath) {
        await safeUnlink(file.path);
      } else if (file.customDriveFinalPath) {
        const { agentDeletePath } = require('../../utils/agentFileOperations');
        await agentDeletePath(file.customDriveFinalPath).catch(() => {});
      }
    }
    return sendError(res, 500, 'Unable to verify storage limit. Please try again.');
  }

  // Process all files in parallel
  const uploadPromises = req.files.map(async file => {
    // Detect and validate actual MIME type from file content
    let actualMimeType = file.mimetype || 'application/octet-stream';

    // Only validate MIME type if file is in UPLOAD_DIR (not already in custom drive)
    if (file.path && !file.customDriveFinalPath) {
      const mimeValidation = await validateMimeType(file.path, file.mimetype, file.originalname);
      if (!mimeValidation.valid) {
        await safeUnlink(file.path);
        throw new Error(`Invalid file type: ${file.originalname}`);
      }
      actualMimeType = mimeValidation.actualMimeType || file.mimetype || 'application/octet-stream';
    }

    // Validate for security concerns (executable files, etc.)
    validateFileUpload(actualMimeType, file.originalname);

    try {
      const createdFile = await userOperationLock(req.userId, () => {
        return createFile(
          file.originalname,
          file.size,
          actualMimeType,
          file.path,
          parentId,
          req.userId,
          file.customDriveFinalPath
        );
      });

      // Log file upload
      await fileUploaded(createdFile.id, createdFile.name, createdFile.size, req);
      logger.info({ fileId: createdFile.id, fileName: createdFile.name, fileSize: createdFile.size }, 'File uploaded');

      // Publish file uploaded event
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
      // Clean up file on error
      if (file.path && !file.customDriveFinalPath) {
        await safeUnlink(file.path);
      } else if (file.customDriveFinalPath) {
        const { agentDeletePath } = require('../../utils/agentFileOperations');
        await agentDeletePath(file.customDriveFinalPath).catch(() => {});
      }
      throw error;
    }
  });

  // Wait for all uploads to complete
  const results = await Promise.allSettled(uploadPromises);

  // Separate successful and failed uploads
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

  // If all failed, return error
  if (successful.length === 0) {
    return sendError(res, 400, failed.length > 0 ? failed[0].error : 'All uploads failed');
  }

  // Return results with success/failure info
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

  // Check if agent is required - STRICT: block if agent is not confirmed online
  const agentResult = await requireAgentOnline(req);
  if (agentResult.error) {
    return sendError(res, agentResult.status, agentResult.message);
  }
  const agentCheck = agentResult.agentCheck;

  const file = await getFile(fileId, req.userId);
  if (!file) {
    return sendError(res, 404, 'File not found');
  }

  // If it's a folder, zip it first
  if (file.type === 'folder') {
    // Additional check: if agent is required, block folder downloads entirely
    // Folder downloads require reading all files, which needs agent access
    if (agentCheck.required && !agentCheck.online) {
      return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
    }

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
      // Check if error is agent-related
      if (isAgentOfflineError(error)) {
        if (!res.headersSent) {
          return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
        }
        // If headers already sent, just log the error
        logger.error(
          { folderId: fileId, error: error.message },
          'Agent error during folder download (headers already sent)'
        );
        return;
      }
      // Re-throw other errors only if headers haven't been sent
      if (!res.headersSent) {
        throw error;
      }
      // If headers already sent, just log
      logger.error({ folderId: fileId, error: error.message }, 'Error during folder download (headers already sent)');
    }
  }

  // For files, download directly
  const { success, filePath, isEncrypted, error: fileError, agentOffline } = await validateAndResolveFile(file);
  if (!success) {
    // If agent is offline, return 503 instead of 404
    if (agentOffline) {
      return sendError(res, AGENT_OFFLINE_STATUS, fileError || AGENT_OFFLINE_MESSAGE);
    }
    return sendError(res, filePath ? 400 : 404, fileError);
  }

  // Log file download
  await fileDownloaded(fileId, file.name, req);
  logger.info({ fileId, fileName: file.name }, 'File downloaded');

  // Check if file should be forced to download (executable files)
  const { requiresDownload } = validateFileUpload(file.mimeType, file.name);

  // Force download for potentially executable files to prevent execution in browser
  if (requiresDownload) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  // If file is encrypted (non-custom-drive), stream decrypted content
  if (isEncrypted) {
    return streamEncryptedFile(res, filePath, file.name, file.mimeType);
  }

  // For unencrypted files (custom-drive), use createReadStream instead of sendFile
  // This handles case-sensitive paths better on Windows
  return streamUnencryptedFile(res, filePath, file.name, file.mimeType, true);
}

/**
 * Rename a file or folder
 */
async function renameFile(req, res) {
  // Check if agent is required
  const agentResult = await requireAgentOnline(req);
  if (agentResult.error) {
    return sendError(res, agentResult.status, agentResult.message);
  }
  const { name, id } = req.body;

  try {
    const file = await renameFileModel(id, name, req.userId);
    if (!file) {
      return sendError(res, 404, 'Not found');
    }

    // Log file rename
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

    // Publish file renamed event
    await publishFileEvent(EventTypes.FILE_RENAMED, {
      id,
      name,
      oldName: file.name,
      type: file.type,
      parentId: file.parentId || null,
      userId: req.userId,
    });

    sendSuccess(res, file);
  } catch (err) {
    // Check if error is agent-related
    if (isAgentOfflineError(err)) {
      logger.error({ fileId: id, newName: name, error: err.message }, 'Agent error during rename');
      return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
    }
    // Re-throw other errors
    throw err;
  }
}

/**
 * Bulk download multiple files/folders as a single ZIP archive
 */
async function downloadFilesBulk(req, res) {
  // Check if agent is required - STRICT: block if agent is not confirmed online
  const agentResult = await requireAgentOnline(req);
  if (agentResult.error) {
    return sendError(res, agentResult.status, agentResult.message);
  }
  const agentCheck = agentResult.agentCheck;

  const { ids } = req.body;

  // Additional check: if agent is required, block bulk downloads entirely
  // Bulk downloads require reading all files, which needs agent access
  if (agentCheck.required && !agentCheck.online) {
    return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
  }

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
    // Check if error is agent-related
    if (isAgentOfflineError(error)) {
      if (!res.headersSent) {
        return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
      }
      logger.error({ fileIds: ids, error: error.message }, 'Agent error during bulk download (headers already sent)');
      return;
    }
    // Re-throw other errors only if headers haven't been sent
    if (!res.headersSent) {
      throw error;
    }
    logger.error({ fileIds: ids, error: error.message }, 'Error during bulk download (headers already sent)');
  }
}

module.exports = {
  listFiles,
  addFolder,
  uploadFile,
  uploadFilesBulk,
  downloadFile,
  downloadFilesBulk,
  renameFile,
};
