import { logger } from '../../config/logger.js';
import { recordAccess } from '../../services/accessTracker.js';
import { fileDownloaded, fileUploaded, filesUploadedBulk, logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEvent } from '../../services/fileEvents.js';
import {
  createFile,
  createFileFromStreamedUpload,
  createFolder,
  findFolderIdByName,
  getFile,
  getFiles,
  getFilesByIds,
  getFolderTree,
  renameFile as renameFileModel,
  replaceFileData,
  replaceFileDataWithStorageKey,
} from '../../models/file.model.js';
import { getUserStorageLimit, getUserStorageUsage } from '../../models/user.model.js';
import { validateParentId } from '../../utils/controllerHelpers.js';
import { collectUploadParts, extractFolderSegmentsFromRelativePath, metadataForPart } from '../../utils/uploadParts.js';
import { safeUnlink } from '../../utils/fileCleanup.js';
import { streamEncryptedFile, streamUnencryptedFile, validateAndResolveFile } from '../../utils/fileDownload.js';
import { userOperationLock } from '../../utils/mutex.js';
import { validateMimeType, validateMimeTypeFromBuffer } from '../../utils/mimeTypeDetection.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import storage from '../../utils/storageDriver.js';
import { checkStorageLimitExceeded } from '../../utils/storageUtils.js';
import {
  validateClientMtime,
  validateFileName,
  validateFileUpload,
  validateSortBy,
  validateSortOrder,
} from '../../utils/validation.js';
import { createBulkZipArchive, createZipArchive } from '../../utils/zipArchive.js';

async function ensureFolderPath({ userId, baseParentId, folderSegments, folderIdCache }) {
  let parentId = baseParentId || null;
  for (const seg of folderSegments) {
    if (!validateFileName(seg)) {
      throw new Error(`Invalid folder name: ${seg}`);
    }

    const cacheKey = `${parentId || 'root'}::${seg}`;
    const cached = folderIdCache.get(cacheKey);
    if (cached) {
      parentId = cached;
      continue;
    }

    const existingId = await findFolderIdByName(seg, parentId, userId);
    if (existingId) {
      folderIdCache.set(cacheKey, existingId);
      parentId = existingId;
      continue;
    }

    const created = await createFolder(seg, parentId, userId);
    folderIdCache.set(cacheKey, created.id);
    parentId = created.id;

    // Ensure newly created folders from bulk/folder uploads are visible in
    // the UI without requiring a manual refresh by publishing the same
    // event used by the explicit "create folder" endpoint.
    await publishFileEvent(EventTypes.FOLDER_CREATED, {
      id: created.id,
      name: created.name,
      type: created.type,
      parentId,
      userId,
    });
  }
  return parentId;
}

async function enforceStorageLimitForUpload({ res, userId, fileSize, cleanup, logMessage }) {
  try {
    const used = await getUserStorageUsage(userId);
    const userStorageLimit = await getUserStorageLimit(userId);
    const checkResult = await checkStorageLimitExceeded({
      fileSize,
      used,
      userStorageLimit,
    });

    if (checkResult.exceeded) {
      if (cleanup) await cleanup();
      sendError(res, 413, checkResult.message);
      return false;
    }
    return true;
  } catch (storageError) {
    logger.error({ err: storageError, userId }, logMessage);
    if (cleanup) await cleanup();
    sendError(res, 500, 'Unable to verify storage limit. Please try again.');
    return false;
  }
}

async function validateDiskUploadOrRespond({ res, file }) {
  if (!file) {
    sendError(res, 400, 'No file uploaded');
    return null;
  }

  if (!validateFileName(file.originalname)) {
    await safeUnlink(file.path);
    sendError(res, 400, 'Invalid file name');
    return null;
  }

  const fallbackMimeType = file.mimetype || 'application/octet-stream';
  const mimeValidation = await validateMimeType(file.path, file.mimetype, file.originalname);
  if (!mimeValidation.valid) {
    await safeUnlink(file.path);
    sendError(res, 400, mimeValidation.error || 'Invalid file type');
    return null;
  }
  const actualMimeType = mimeValidation.actualMimeType || fallbackMimeType;

  validateFileUpload(actualMimeType, file.originalname);
  return actualMimeType;
}

/**
 * Runs the extension check against the header bytes a client offers up front,
 * so a file whose content contradicts its name is refused before it is sent.
 *
 * Advisory only: nothing here is trusted, because a client is free to send a
 * flattering sample and then upload something else. It exists to spare an
 * honest client a pointless transfer, not to replace the check on the way in.
 *
 * @param {Array<{name: string, head: string}>} samples
 * @returns {Promise<Array<{fileName: string, reason: string}>>} refused files
 */
async function findRefusedUploadSamples(samples) {
  const refused = [];
  for (const { name, head } of samples) {
    const buffer = Buffer.from(head, 'base64');
    const result = await validateMimeTypeFromBuffer(buffer, name);
    if (!result.valid) {
      refused.push({ fileName: name, reason: result.error || 'Invalid file type' });
    }
  }
  return refused;
}

/**
 * Check whether an upload would be refused (call before starting one).
 * Returns 200 { allowed: true }, 413 when it would exceed the storage limit, or
 * 415 listing the files whose content contradicts their extension.
 */
async function checkUploadStorage(req, res) {
  const fileSize = Number(req.body.fileSize);
  if (!Number.isInteger(fileSize) || fileSize < 0) {
    return sendError(res, 400, 'fileSize must be a non-negative integer');
  }
  const samples = Array.isArray(req.body.samples) ? req.body.samples : [];
  try {
    const used = await getUserStorageUsage(req.ownerId);
    const userStorageLimit = await getUserStorageLimit(req.ownerId);

    const checkResult = await checkStorageLimitExceeded({
      fileSize,
      used,
      userStorageLimit,
    });

    if (checkResult.exceeded) {
      return sendError(res, 413, checkResult.message);
    }

    const refused = await findRefusedUploadSamples(samples);
    if (refused.length > 0) {
      return sendError(res, 415, refused[0].reason, null, { refused });
    }

    return sendSuccess(res, { allowed: true });
  } catch (err) {
    logger.error({ err, userId: req.userId, ownerId: req.ownerId }, 'Error checking upload storage');
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
  const files = await getFiles(req.ownerId, parentId, sortBy, order);

  // Enumerating a directory touches the directory, not the children — the same
  // line Windows draws. Listing a folder full of files must not restamp every
  // file inside it, or "last opened" would only ever mean "last browsed past".
  // The root is not a row, so there is nothing to stamp there.
  recordAccess(parentId, req.ownerId);

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
  const folder = await createFolder(name, parentId, req.ownerId);

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
    userId: req.ownerId,
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

    const modified = validateClientMtime(req.body?.lastModifiedTimes);
    const file = await userOperationLock(req.ownerId, () => {
      return createFileFromStreamedUpload({ ...upload, modified }, parentId, req.ownerId);
    });

    // Upload consumed successfully — prevent auto-cleanup from deleting it.
    if (req._s3UploadedKeys) {
      req._s3UploadedKeys = req._s3UploadedKeys.filter(k => k !== upload.storageName);
    }

    await fileUploaded(file.id, file.name, file.size, req);
    logger.info({ fileId: file.id, fileName: file.name, fileSize: file.size }, 'File uploaded (stream to S3)');
    await publishFileEvent(EventTypes.FILE_UPLOADED, {
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      mimeType: file.mimeType,
      parentId,
      userId: req.ownerId,
    });
    return sendSuccess(res, file);
  }

  if (!req.file) {
    return sendError(res, 400, 'No file uploaded');
  }

  const actualMimeType = await validateDiskUploadOrRespond({ res, file: req.file });
  if (!actualMimeType) return;

  const { valid, parentId, error } = validateParentId(req);
  if (!valid) {
    await safeUnlink(req.file.path);
    return sendError(res, 400, error);
  }

  const storageOk = await enforceStorageLimitForUpload({
    res,
    userId: req.ownerId,
    fileSize: req.file.size,
    cleanup: () => safeUnlink(req.file.path),
    logMessage: 'Error checking storage limit',
  });
  if (!storageOk) return;

  const modified = validateClientMtime(req.body?.lastModifiedTimes);
  const file = await userOperationLock(req.ownerId, () => {
    return createFile(
      req.file.originalname,
      req.file.size,
      actualMimeType,
      req.file.path,
      parentId,
      req.ownerId,
      modified
    );
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
    userId: req.ownerId,
  });

  sendSuccess(res, file);
}

/**
 * Replace contents of an existing file (used by desktop editor integration)
 */
async function replaceFileContents(req, res) {
  const fileId = req.params.id;

  // S3: bytes streamed to a fresh key (no temp file); repoint the DB row.
  if (req.streamedUpload) {
    const upload = req.streamedUpload;

    // Drop the streamed object when we bail out.
    const discardStreamedObject = () => {
      if (!upload?.storageName) return;
      if (req._s3UploadedKeys) {
        req._s3UploadedKeys = req._s3UploadedKeys.filter(k => k !== upload.storageName);
      }
      storage
        .deleteObject(upload.storageName)
        .catch(err =>
          logger.warn({ err, storageName: upload.storageName }, 'Failed to delete orphaned S3 object after replace')
        );
    };

    try {
      const existing = await getFile(fileId, req.ownerId);
      if (!existing) {
        discardStreamedObject();
        return sendError(res, 404, 'File not found');
      }

      if (!validateFileName(existing.name)) {
        discardStreamedObject();
        return sendError(res, 400, 'Invalid file name');
      }

      // Magic bytes already checked in streamUploadToS3; validate MIME + name here.
      validateFileUpload(upload.mimeType, existing.name);

      const updated = await replaceFileDataWithStorageKey(
        fileId,
        upload.size,
        upload.mimeType || 'application/octet-stream',
        upload.storageName,
        req.ownerId,
        validateClientMtime(req.body?.lastModifiedTimes)
      );

      if (!updated) {
        discardStreamedObject();
        return sendError(res, 404, 'File not found');
      }

      // Consumed — keep it out of the middleware's auto-cleanup.
      if (req._s3UploadedKeys) {
        req._s3UploadedKeys = req._s3UploadedKeys.filter(k => k !== upload.storageName);
      }

      await logAuditEvent(
        'file.update',
        {
          status: 'success',
          resourceType: updated.type,
          resourceId: updated.id,
          metadata: { fileName: updated.name, size: updated.size },
        },
        req
      );
      logger.info({ fileId, fileName: updated.name }, 'File contents updated (stream to S3)');

      await publishFileEvent(EventTypes.FILE_UPDATED, {
        id: updated.id,
        name: updated.name,
        type: updated.type,
        size: updated.size,
        mimeType: updated.mimeType,
        parentId: updated.parentId || null,
        userId: req.ownerId,
      });

      return sendSuccess(res, updated);
    } catch (err) {
      logger.error({ err, fileId }, 'Error replacing file contents (S3)');
      discardStreamedObject();
      return sendError(res, 500, 'Failed to update file');
    }
  }

  if (!req.file) {
    return sendError(res, 400, 'No file uploaded');
  }

  try {
    const existing = await getFile(fileId, req.ownerId);
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

    const updated = await replaceFileData(
      fileId,
      req.file.size,
      actualMimeType,
      req.file.path,
      req.ownerId,
      validateClientMtime(req.body?.lastModifiedTimes)
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
      userId: req.ownerId,
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
 * Upload a new file derived from an existing one (e.g. desktop "Save as PDF").
 * The new file is created in the same parent folder as the original file.
 */
async function uploadDerivedFile(req, res) {
  const fileId = req.params.id;

  try {
    const existing = await getFile(fileId, req.ownerId);
    if (!existing) {
      return sendError(res, 404, 'File not found');
    }

    // S3 path: streamUploadToS3 middleware sets req.streamedUpload
    if (req.streamedUpload) {
      const upload = req.streamedUpload;
      if (!upload) {
        return sendError(res, 400, 'No file uploaded');
      }

      if (!validateFileName(upload.name)) {
        return sendError(res, 400, 'Invalid file name');
      }

      // Validate by MIME + extension (content has already passed magic-byte checks in streamUploadToS3)
      validateFileUpload(upload.mimeType, upload.name);

      const storageOk = await enforceStorageLimitForUpload({
        res,
        userId: req.ownerId,
        fileSize: upload.size,
        cleanup: null,
        logMessage: 'Error checking storage limit (derived upload, S3)',
      });
      if (!storageOk) return;

      const newFile = await userOperationLock(req.ownerId, () => {
        return createFileFromStreamedUpload(upload, existing.parentId || null, req.ownerId);
      });

      // Upload consumed successfully — remove from auto-cleanup list.
      if (req._s3UploadedKeys) {
        req._s3UploadedKeys = req._s3UploadedKeys.filter(k => k !== upload.storageName);
      }

      await fileUploaded(newFile.id, newFile.name, newFile.size, req);
      logger.info(
        { fileId: newFile.id, fileName: newFile.name, fileSize: newFile.size, derivedFrom: existing.id },
        'Derived file uploaded (S3)'
      );

      await publishFileEvent(EventTypes.FILE_UPLOADED, {
        id: newFile.id,
        name: newFile.name,
        type: newFile.type,
        size: newFile.size,
        mimeType: newFile.mimeType,
        parentId: newFile.parentId || existing.parentId || null,
        userId: req.ownerId,
      });

      return sendSuccess(res, newFile);
    }

    // Local disk path (no S3)
    const actualMimeType = await validateDiskUploadOrRespond({ res, file: req.file });
    if (!actualMimeType) return;

    const storageOk = await enforceStorageLimitForUpload({
      res,
      userId: req.ownerId,
      fileSize: req.file.size,
      cleanup: () => safeUnlink(req.file.path),
      logMessage: 'Error checking storage limit (derived upload)',
    });
    if (!storageOk) return;

    const newFile = await userOperationLock(req.ownerId, () => {
      return createFile(
        req.file.originalname,
        req.file.size,
        actualMimeType,
        req.file.path,
        existing.parentId || null,
        req.ownerId
      );
    });

    await fileUploaded(newFile.id, newFile.name, newFile.size, req);
    logger.info(
      { fileId: newFile.id, fileName: newFile.name, fileSize: newFile.size, derivedFrom: existing.id },
      'Derived file uploaded'
    );

    await publishFileEvent(EventTypes.FILE_UPLOADED, {
      id: newFile.id,
      name: newFile.name,
      type: newFile.type,
      size: newFile.size,
      mimeType: newFile.mimeType,
      parentId: newFile.parentId || existing.parentId || null,
      userId: req.ownerId,
    });

    return sendSuccess(res, newFile);
  } catch (err) {
    logger.error({ err, fileId }, 'Error uploading derived file');
    if (req.file?.path) {
      try {
        await safeUnlink(req.file.path);
      } catch (_) {
        // ignore
      }
    }
    return sendError(res, 500, 'Failed to upload derived file');
  }
}

/**
 * Bulk upload multiple files (multer disk/local or stream-to-S3 when S3 enabled)
 */
async function uploadFilesBulk(req, res) {
  const parts = collectUploadParts(req.body);
  const folderIdCache = new Map();
  const mimeFallbackWarnings = [];
  const mimeMismatchWarnings = [];
  const mimeSpoofingWarnings = [];

  // S3: streamed uploads (no temp files)
  if (req.streamedUploads) {
    const uploads = req.streamedUploads;
    // Files the stream middleware rejected (MIME spoof, oversized) never reach
    // S3; they still have to be reported or the client waits on them forever.
    const streamFailures = (req.streamedUploadFailures || []).map(f => {
      const { clientId } = metadataForPart(parts, f.index);
      return { fileName: f.fileName, error: f.error, ...(clientId ? { clientId } : {}) };
    });
    if (uploads.length === 0) {
      return sendError(res, 400, streamFailures[0]?.error || 'No files uploaded');
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
    const failed = [...streamFailures];

    const orderedUploads = [...uploads].sort((a, b) => {
      const ai = Number.isFinite(a?.index) ? a.index : 0;
      const bi = Number.isFinite(b?.index) ? b.index : 0;
      return ai - bi;
    });

    for (const upload of orderedUploads) {
      const { relativePath, clientId, modified } = metadataForPart(parts, upload.index);

      try {
        const folderSegments = extractFolderSegmentsFromRelativePath(relativePath, upload.name);
        const targetParentId =
          folderSegments.length > 0
            ? await ensureFolderPath({
                userId: req.ownerId,
                baseParentId: parentId,
                folderSegments,
                folderIdCache,
              })
            : parentId;

        const file = await userOperationLock(req.ownerId, () => {
          return createFileFromStreamedUpload({ ...upload, modified }, targetParentId, req.ownerId);
        });
        // Upload consumed successfully — remove from auto-cleanup list.
        if (req._s3UploadedKeys) {
          req._s3UploadedKeys = req._s3UploadedKeys.filter(k => k !== upload.storageName);
        }
        // For bulk uploads, avoid per-file audit/info spam; we log a single bulk event below.
        logger.debug({ fileId: file.id, fileName: file.name }, 'File uploaded (stream to S3, bulk)');
        await publishFileEvent(EventTypes.FILE_UPLOADED, {
          id: file.id,
          name: file.name,
          type: file.type,
          size: file.size,
          mimeType: file.mimeType,
          parentId: targetParentId,
          userId: req.ownerId,
        });
        successful.push(clientId ? { ...file, clientId } : file);
      } catch (err) {
        // Best-effort cleanup: streamed object is already in S3; delete it if DB creation failed.
        if (upload?.storageName) {
          // Remove from auto-cleanup list (we handle it here explicitly).
          if (req._s3UploadedKeys) {
            req._s3UploadedKeys = req._s3UploadedKeys.filter(k => k !== upload.storageName);
          }
          storage
            .deleteObject(upload.storageName)
            .catch(cleanupErr =>
              logger.warn(
                { err: cleanupErr, storageName: upload.storageName },
                'Failed to delete orphaned S3 object after bulk upload failure'
              )
            );
        }
        const failure = { fileName: upload.name, error: err?.message || 'Upload failed' };
        failed.push(clientId ? { ...failure, clientId } : failure);
      }
    }

    if (successful.length === 0) {
      return sendError(res, 400, failed[0]?.error || 'All uploads failed');
    }

    // Rejected-before-S3 files are part of what the client sent, so they count
    // towards the total it is waiting on.
    const total = uploads.length + streamFailures.length;

    // Aggregate audit log for this bulk upload.
    await filesUploadedBulk(successful, req, {
      failedCount: failed.length,
      total,
      parentId,
      driver: 's3',
    });
    logger.info(
      {
        total,
        successful: successful.length,
        failedCount: failed.length,
        parentId,
        driver: 's3',
      },
      'Bulk upload completed (stream to S3)'
    );

    return sendSuccess(res, {
      files: successful,
      failed: failed.length > 0 ? failed : undefined,
      total,
      successful: successful.length,
      failedCount: failed.length,
    });
  }

  if (!req.files || req.files.length === 0) {
    return sendError(res, 400, 'No files uploaded');
  }
  // Defensive: req.files should be an array here, but keep logging robust
  // so streamed uploads can never crash this controller.
  const totalFiles = Array.isArray(req.files) ? req.files.length : 0;

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
  const storageOk = await enforceStorageLimitForUpload({
    res,
    userId: req.ownerId,
    fileSize: totalSize,
    cleanup: async () => {
      for (const file of req.files) {
        await safeUnlink(file.path);
      }
    },
    logMessage: 'Error checking storage limit',
  });
  if (!storageOk) return;

  // IMPORTANT: Process sequentially to avoid race conditions creating the same folder path multiple times.
  // (Parallel processing can create duplicate folders due to cache/DB check races.)
  const successful = [];
  const failed = [];

  // Multer keeps every part it accepts, so here a file's position is its part
  // ordinal but the lookup goes through the same join either way, so the two
  // paths cannot drift apart.
  for (let index = 0; index < totalFiles; index++) {
    const file = req.files[index];
    const { relativePath, clientId, modified } = metadataForPart(parts, index);

    try {
      let actualMimeType = file.mimetype || 'application/octet-stream';
      const mimeValidation = await validateMimeType(file.path, file.mimetype, file.originalname, {
        suppressFallbackWarning: true,
        onFallback: warning => {
          mimeFallbackWarnings.push(warning);
        },
        suppressMismatchWarning: true,
        onMismatch: warning => {
          mimeMismatchWarnings.push(warning);
        },
      });
      if (!mimeValidation.valid) {
        await safeUnlink(file.path);
        throw new Error(`Invalid file type: ${file.originalname}`);
      }
      actualMimeType = mimeValidation.actualMimeType || file.mimetype || 'application/octet-stream';

      validateFileUpload(actualMimeType, file.originalname, {
        suppressSpoofingWarning: true,
        onSpoofing: warning => {
          mimeSpoofingWarnings.push(warning);
        },
      });

      const folderSegments = extractFolderSegmentsFromRelativePath(relativePath, file.originalname);
      const targetParentId =
        folderSegments.length > 0
          ? await ensureFolderPath({
              userId: req.ownerId,
              baseParentId: parentId,
              folderSegments,
              folderIdCache,
            })
          : parentId;

      const createdFile = await userOperationLock(req.ownerId, () => {
        return createFile(
          file.originalname,
          file.size,
          actualMimeType,
          file.path,
          targetParentId,
          req.ownerId,
          modified
        );
      });

      // For bulk uploads, avoid per-file audit/info spam; we log a single bulk event below.
      logger.debug(
        { fileId: createdFile.id, fileName: createdFile.name, fileSize: createdFile.size },
        'File uploaded (bulk)'
      );

      await publishFileEvent(EventTypes.FILE_UPLOADED, {
        id: createdFile.id,
        name: createdFile.name,
        type: createdFile.type,
        size: createdFile.size,
        mimeType: createdFile.mimeType,
        parentId: targetParentId,
        userId: req.ownerId,
      });

      successful.push(clientId ? { ...createdFile, clientId } : createdFile);
    } catch (err) {
      // Ensure we don't leak temp files on failures.
      if (file?.path) {
        await safeUnlink(file.path);
      }
      failed.push({
        fileName: file.originalname,
        error: err?.message || 'Upload failed',
        ...(clientId ? { clientId } : {}),
      });
    }
  }

  const anyMimeSecurityWarnings =
    mimeFallbackWarnings.length > 0 || mimeMismatchWarnings.length > 0 || mimeSpoofingWarnings.length > 0;

  if (anyMimeSecurityWarnings) {
    const SAMPLE_LIMIT = 20;

    const sampledFallback = mimeFallbackWarnings.slice(0, SAMPLE_LIMIT).map(item => item.filename);
    const sampledMismatch = mimeMismatchWarnings.slice(0, SAMPLE_LIMIT).map(item => item.filename);
    const sampledSpoofing = mimeSpoofingWarnings.slice(0, SAMPLE_LIMIT).map(item => item.filename);

    const byDeclaredMimeType = mimeFallbackWarnings.reduce((acc, item) => {
      const key = item?.declaredMimeType || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const byMismatchDeclaredMimeType = mimeMismatchWarnings.reduce((acc, item) => {
      const key = item?.declaredMimeType || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const bySpoofingMimeType = mimeSpoofingWarnings.reduce((acc, item) => {
      const key = item?.mimeType || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    logger.warn(
      {
        totalFiles,
        fallbackCount: mimeFallbackWarnings.length,
        mismatchCount: mimeMismatchWarnings.length,
        spoofingCount: mimeSpoofingWarnings.length,
        sampledFallbackFiles: sampledFallback,
        sampledMismatchFiles: sampledMismatch,
        sampledSpoofingFiles: sampledSpoofing,
        sampleTruncated:
          mimeFallbackWarnings.length > SAMPLE_LIMIT ||
          mimeMismatchWarnings.length > SAMPLE_LIMIT ||
          mimeSpoofingWarnings.length > SAMPLE_LIMIT,
        byDeclaredMimeType,
        byMismatchDeclaredMimeType,
        bySpoofingMimeType,
      },
      'Bulk upload MIME security warnings summary (per-file warnings suppressed)'
    );
  }

  if (successful.length === 0) {
    return sendError(res, 400, failed.length > 0 ? failed[0].error : 'All uploads failed');
  }

  // Aggregate audit log + summary log entry for this bulk upload.
  await filesUploadedBulk(successful, req, {
    failedCount: failed.length,
    total: totalFiles,
    parentId,
    driver: 'disk',
  });
  logger.info(
    {
      total: totalFiles,
      successful: successful.length,
      failedCount: failed.length,
      parentId,
      driver: 'disk',
    },
    'Bulk upload completed'
  );

  sendSuccess(res, {
    files: successful,
    failed: failed.length > 0 ? failed : undefined,
    total: totalFiles,
    successful: successful.length,
    failedCount: failed.length,
  });
}

/**
 * Download a file or folder
 */
async function downloadFile(req, res) {
  const { id: fileId } = req.params;

  const file = await getFile(fileId, req.ownerId);
  if (!file) {
    return sendError(res, 404, 'File not found');
  }

  // If it's a folder, zip it first
  if (file.type === 'folder') {
    try {
      return await userOperationLock(req.ownerId, async () => {
        const entries = await getFolderTree(fileId, req.ownerId);

        // Zipping a folder reads every item under it, so the whole subtree is
        // accessed, not just the folder that was clicked.
        recordAccess([fileId, ...entries.map(entry => entry.id)], req.ownerId);

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
  recordAccess(fileId, req.ownerId);
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

  const file = await renameFileModel(id, name, req.ownerId);
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
    userId: req.ownerId,
  });

  sendSuccess(res, file);
}

/**
 * Bulk download multiple files/folders as a single ZIP archive
 */
async function downloadFilesBulk(req, res) {
  const { ids } = req.body;

  try {
    return await userOperationLock(req.ownerId, async () => {
      // Get all files/folders to download in a single query (bulk operation)
      const filesToDownload = await getFilesByIds(ids, req.ownerId);

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
          const entries = await getFolderTree(file.id, req.ownerId);
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

      // Every entry that goes into the archive gets read on the way in.
      recordAccess([...rootIds, ...allEntries.map(entry => entry.id)], req.ownerId);

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

export {
  listFiles,
  addFolder,
  checkUploadStorage,
  uploadFile,
  uploadFilesBulk,
  downloadFile,
  downloadFilesBulk,
  renameFile,
  replaceFileContents,
  uploadDerivedFile,
};
