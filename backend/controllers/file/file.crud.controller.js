const { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile } = require('../../utils/fileDownload');
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
const { validateFileName, validateSortBy, validateSortOrder, validateFileUpload } = require('../../utils/validation');
const { validateParentId, validateSingleId } = require('../../utils/controllerHelpers');
const { getUserStorageUsage, getUserCustomDriveSettings, getUserStorageLimit } = require('../../models/user.model');
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
  sendSuccess(res, files);
}

/**
 * Create a new folder
 */
async function addFolder(req, res) {
  const { name } = req.body;
  if (!name || !validateFileName(name)) {
    return sendError(res, 400, 'Invalid folder name');
  }
  const { valid, parentId: validatedParentId, error } = validateParentId(req);
  if (!valid) {
    return sendError(res, 400, error);
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
  const mimeValidation = await validateMimeType(req.file.path, req.file.mimetype, req.file.originalname);
  if (!mimeValidation.valid) {
    await safeUnlink(req.file.path);
    return sendError(res, 400, mimeValidation.error || 'Invalid file type');
  }

  // Use actual MIME type detected from file content (not the declared one)
  const actualMimeType = mimeValidation.actualMimeType || req.file.mimetype || 'application/octet-stream';

  // Validate for security concerns (executable files, etc.)
  validateFileUpload(actualMimeType, req.file.originalname);

  const { valid, parentId, error } = validateParentId(req);
  if (!valid) {
    await safeUnlink(req.file.path);
    return sendError(res, 400, error);
  }

  // Check if agent is required - STRICT: block if agent is not confirmed online
  const agentResult = await requireAgentOnline(req);
  if (agentResult.error) {
    await safeUnlink(req.file.path);
    return sendError(res, agentResult.status, agentResult.message);
  }

  // Final safeguard: Check storage limit with actual file size
  // (Middleware checks using Content-Length estimate, this uses actual size for accuracy)
  try {
    const customDrive = await getUserCustomDriveSettings(req.userId);
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
 * Download a file or folder
 */
async function downloadFile(req, res) {
  const { valid, id: fileId, error } = validateSingleId(req);
  if (!valid) {
    return sendError(res, 400, error);
  }

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
  const { name } = req.body;
  const { valid, id: validatedId, error } = validateSingleId(req, 'id', 'body');
  if (!valid) {
    return sendError(res, 400, error);
  }
  if (!name || !validateFileName(name)) {
    return sendError(res, 400, 'Invalid file name');
  }

  try {
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
    // Check if error is agent-related
    if (isAgentOfflineError(err)) {
      logger.error({ fileId: validatedId, newName: name, error: err.message }, 'Agent error during rename');
      return sendError(res, AGENT_OFFLINE_STATUS, AGENT_OFFLINE_MESSAGE);
    }
    // Re-throw other errors
    throw err;
  }
}

module.exports = {
  listFiles,
  addFolder,
  uploadFile,
  downloadFile,
  renameFile,
};
