import { logger } from '../../config/logger.js';
import { fileUploaded, logAuditEvent } from '../../services/auditLogger.js';
import { EventTypes, publishFileEvent } from '../../services/fileEvents.js';
import {
  createFile,
  createFileFromStreamedUpload,
  getFile,
  replaceFileData,
  replaceFileDataWithStorageKey,
} from '../../models/file.model.js';
import { getUserStorageLimit, getUserStorageUsage } from '../../models/user.model.js';
import { validateParentId } from '../../utils/controllerHelpers.js';
import { safeUnlink } from '../../utils/fileCleanup.js';
import { userOperationLock } from '../../utils/mutex.js';
import { validateMimeType } from '../../utils/mimeTypeDetection.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import storage from '../../utils/storageDriver.js';
import { checkStorageLimitExceeded } from '../../utils/storageUtils.js';
import { validateClientMtime, validateFileName, validateFileUpload } from '../../utils/validation.js';
import { linkNewItemsToParentShare } from '../../services/shareLinking.js';
import { enforceStorageLimitForUpload, validateDiskUploadOrRespond } from './file.upload.helpers.js';

/**
 * Check whether an upload would fit before starting one.
 * Returns 200 { allowed: true }, or 413 when it would exceed the storage limit.
 */
async function checkUploadStorage(req, res) {
  const fileSize = Number(req.body.fileSize);
  if (!Number.isInteger(fileSize) || fileSize < 0) {
    return sendError(res, 400, 'fileSize must be a non-negative integer');
  }
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

    return sendSuccess(res, { allowed: true });
  } catch (err) {
    logger.error({ err, userId: req.userId, ownerId: req.ownerId }, 'Error checking upload storage');
    return sendError(res, 500, 'Unable to verify storage limit. Please try again.');
  }
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

    // Consumed — keep out of the middleware's auto-cleanup.
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
    await linkNewItemsToParentShare({ ownerId: req.ownerId, parentId, itemIds: [file.id] });
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
  await linkNewItemsToParentShare({ ownerId: req.ownerId, parentId, itemIds: [file.id] });

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

      // mimeType came from content sniffing in streamUploadToS3; check the name.
      validateFileUpload(upload.mimeType, existing.name);

      const updated = await replaceFileDataWithStorageKey(
        fileId,
        upload.size,
        upload.mimeType || 'application/octet-stream',
        upload.storageName,
        req.ownerId,
        validateClientMtime(req.body?.lastModifiedTimes),
        { dekWrapped: upload.dekWrapped ?? null, dekKekVersion: upload.dekKekVersion ?? null }
      );

      if (!updated) {
        discardStreamedObject();
        return sendError(res, 404, 'File not found');
      }

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

      // mimeType came from content sniffing in streamUploadToS3; check the name.
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
      await linkNewItemsToParentShare({
        ownerId: req.ownerId,
        parentId: newFile.parentId || existing.parentId || null,
        itemIds: [newFile.id],
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
    await linkNewItemsToParentShare({
      ownerId: req.ownerId,
      parentId: newFile.parentId || existing.parentId || null,
      itemIds: [newFile.id],
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

export { checkUploadStorage, uploadFile, replaceFileContents, uploadDerivedFile };
export { uploadFilesBulk } from './file.bulkUpload.controller.js';
