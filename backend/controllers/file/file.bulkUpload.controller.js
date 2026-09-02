import { logger } from '../../config/logger.js';
import { filesUploadedBulk } from '../../services/auditLogger.js';
import { EventTypes, publishFileEvent } from '../../services/fileEvents.js';
import { createFile, createFileFromStreamedUpload } from '../../models/file.model.js';
import { validateParentId } from '../../utils/controllerHelpers.js';
import { collectUploadParts, extractFolderSegmentsFromRelativePath, metadataForPart } from '../../utils/uploadParts.js';
import { safeUnlink } from '../../utils/fileCleanup.js';
import { userOperationLock } from '../../utils/mutex.js';
import { validateMimeType } from '../../utils/mimeTypeDetection.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import storage from '../../utils/storageDriver.js';
import { validateFileName, validateFileUpload } from '../../utils/validation.js';
import { linkNewItemsToParentShare } from '../../services/shareLinking.js';
import { ensureFolderPath, enforceStorageLimitForUpload } from './file.upload.helpers.js';

/** New item ids created by a bulk upload: the files plus any folders it made. */
function createdItemIds(successful, folderIdCache) {
  return [...successful.map(f => f.id), ...folderIdCache.values()];
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
    // Middleware-rejected files (MIME spoof, oversized) never reached S3 but
    // must still be reported, or the client waits on them forever.
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
        // Consumed — keep out of the middleware's auto-cleanup.
        if (req._s3UploadedKeys) {
          req._s3UploadedKeys = req._s3UploadedKeys.filter(k => k !== upload.storageName);
        }
        // One bulk audit event is logged below, so keep per-file quiet.
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
        // DB creation failed but the object is already in S3 — delete it here.
        if (upload?.storageName) {
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

    await linkNewItemsToParentShare({
      ownerId: req.ownerId,
      parentId,
      itemIds: createdItemIds(successful, folderIdCache),
    });

    // Rejected-before-S3 files still count toward the total the client awaits.
    const total = uploads.length + streamFailures.length;

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
  // Defensive: keep the count robust even if req.files isn't an array.
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

  // Process sequentially: parallel runs race to create the same folder path.
  const successful = [];
  const failed = [];

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

      // One bulk audit event is logged below, so keep per-file quiet.
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

  await linkNewItemsToParentShare({
    ownerId: req.ownerId,
    parentId,
    itemIds: createdItemIds(successful, folderIdCache),
  });

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

export { uploadFilesBulk };
