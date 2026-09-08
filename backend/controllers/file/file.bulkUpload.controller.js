import { logger } from '../../config/logger.js';
import { filesUploadedBulk } from '../../services/auditLogger.js';
import { EventTypes, publishFileEvent } from '../../services/fileEvents.js';
import { createFileFromStreamedUpload } from '../../models/file.model.js';
import { validateParentId } from '../../utils/controllerHelpers.js';
import { collectUploadParts, extractFolderSegmentsFromRelativePath, metadataForPart } from '../../utils/uploadParts.js';
import { userOperationLock } from '../../utils/mutex.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import storage from '../../utils/storageDriver.js';
import { validateFileName, validateFileUpload } from '../../utils/validation.js';
import { linkNewItemsToParentShare } from '../../services/shareLinking.js';
import { ensureFolderPath } from './file.upload.helpers.js';

/** New item ids created by a bulk upload: the files plus any folders it made. */
function createdItemIds(successful, folderIdCache) {
  return [...successful.map(f => f.id), ...folderIdCache.values()];
}

/**
 * Bulk upload multiple files (streamed to the bucket)
 */
async function uploadFilesBulk(req, res) {
  const parts = collectUploadParts(req.body);
  const folderIdCache = new Map();

  // S3: streamed uploads (no temp files)
  if (!req.streamedUploads) return sendError(res, 400, 'No files uploaded');

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

export { uploadFilesBulk };
