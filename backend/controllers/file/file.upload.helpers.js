/**
 * Shared helpers for the upload controllers (single + bulk): folder-path
 * materialisation, storage-limit enforcement, and disk-upload validation.
 */

import { logger } from '../../config/logger.js';
import { EventTypes, publishFileEvent } from '../../services/fileEvents.js';
import { createFolder, findFolderIdByName } from '../../models/file.model.js';
import { getUserStorageLimit, getUserStorageUsage } from '../../models/user.model.js';
import { sendError } from '../../utils/response.js';
import { checkStorageLimitExceeded } from '../../utils/storageUtils.js';
import { validateFileName } from '../../utils/validation.js';

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

    // Publish so folders auto-created by bulk uploads show without a refresh.
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

export { ensureFolderPath, enforceStorageLimitForUpload };
