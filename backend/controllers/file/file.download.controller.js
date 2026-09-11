import { logger } from '../../config/logger.js';
import { recordAccess } from '../../services/accessTracker.js';
import { fileDownloaded, logAuditEvent } from '../../services/auditLogger.js';
import { getFile, getFilesByIds, streamArchiveEntries } from '../../models/file.model.js';
import { streamEncryptedFile, streamUnencryptedFile, validateAndResolveFile } from '../../utils/fileDownload.js';
import { userOperationLock } from '../../utils/mutex.js';
import { sendError } from '../../utils/response.js';
import { validateFileUpload } from '../../utils/validation.js';
import { createStreamingZipArchive } from '../../utils/zipArchive.js';

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
        await createStreamingZipArchive(
          res,
          file.name,
          streamArchiveEntries([fileId], req.ownerId),
          entry => recordAccess(entry.id, req.ownerId),
          async () => {
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
          }
        );
      });
    } catch (error) {
      if (!res.headersSent) {
        throw error;
      }
      logger.error({ folderId: fileId, error: error.message }, 'Error during folder download (headers already sent)');
    }
  }

  // storageKey is the object key stored in the database.
  const { success, storageKey, ciphertextSize, isEncrypted, error: fileError } = await validateAndResolveFile(file);
  if (!success) {
    return sendError(res, fileError?.startsWith('Invalid') ? 400 : 404, fileError);
  }

  await fileDownloaded(fileId, file.name, req);
  recordAccess(fileId, req.ownerId);
  logger.info({ fileId, fileName: file.name }, 'File downloaded');

  // Force download for executable types so the browser can't run them.
  const { requiresDownload } = validateFileUpload(file.mimeType, file.name);
  const inlineImage = req.query.inline === '1' && file.mimeType?.startsWith('image/') && !requiresDownload;
  if (requiresDownload) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  if (isEncrypted) {
    return streamEncryptedFile(res, storageKey, file.name, file.mimeType, {
      req,
      ciphertextSize,
      disposition: inlineImage ? 'inline' : 'attachment',
    });
  }
  return streamUnencryptedFile(res, storageKey, file.name, file.mimeType, !inlineImage, {
    req,
    size: ciphertextSize,
  });
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

      const rootIds = [];
      const fileNames = [];

      for (const file of filesToDownload) {
        fileNames.push(file.name);
        rootIds.push(file.id);
      }

      const archiveName = filesToDownload.length === 1 ? filesToDownload[0].name : `download_${Date.now()}`;
      const entries = streamArchiveEntries(rootIds, req.ownerId);
      await createStreamingZipArchive(
        res,
        archiveName,
        entries,
        entry => recordAccess(entry.id, req.ownerId),
        async () => {
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
        }
      );
    });
  } catch (error) {
    if (!res.headersSent) {
      throw error;
    }
    logger.error({ fileIds: ids, error: error.message }, 'Error during bulk download (headers already sent)');
  }
}

export { downloadFile, downloadFilesBulk };
