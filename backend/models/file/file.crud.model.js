const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { safeUnlink } = require('../../utils/fileCleanup');
const { generateId } = require('../../utils/id');
const { UPLOAD_DIR } = require('../../config/paths');
const { logger } = require('../../config/logger');
const {
  getCache,
  setCache,
  deleteCache,
  cacheKeys,
  invalidateFileCache,
  invalidateSearchCache,
  DEFAULT_TTL,
} = require('../../utils/cache');
const { getUserCustomDrive } = require('./file.cache.model');
const { buildOrderClause, fillFolderSizes, getFolderPath, getUniqueFolderPath } = require('./file.utils.model');
const { encryptFile } = require('../../utils/fileEncryption');
const { agentMkdir, agentDeletePath, agentRenamePath } = require('../../utils/agentFileOperations');

/**
 * Get files in a directory
 */
async function getFiles(userId, parentId = null, sortBy = 'modified', order = 'DESC') {
  // Try to get from cache first
  const cacheKey = cacheKeys.files(userId, parentId, sortBy, order);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared, path
     FROM files
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}
     ${orderClause}`,
    parentId ? [userId, parentId] : [userId]
  );
  let files = result.rows;

  // SAFETY: For custom-drive users, filter out any "ghost" entries whose paths
  // no longer exist on disk (for example, if an earlier sync or rename left
  // behind a stale DB row). This ensures the UI never shows a file that
  // physically does not exist in the custom drive directory, even if the
  // scanner or a previous bug produced an inconsistent record.
  try {
    const customDrive = await getUserCustomDrive(userId);
    if (customDrive.enabled && customDrive.path) {
      const { agentPathExists } = require('../../utils/agentFileOperations');

      const checks = await Promise.all(
        files.map(async file => {
          if (file.path && path.isAbsolute(file.path)) {
            const exists = await agentPathExists(file.path);
            return { file, exists };
          }
          return { file, exists: true };
        })
      );

      const beforeCount = files.length;
      files = checks.filter(entry => entry.exists).map(entry => entry.file);

      if (files.length !== beforeCount) {
        logger.warn(
          {
            userId,
            removedCount: beforeCount - files.length,
          },
          '[File] Filtered out ghost custom-drive entries with missing paths in getFiles'
        );
      }
    }
  } catch (error) {
    // If agent/custom-drive checks fail, fall back to returning the raw DB rows
    // rather than breaking listing entirely.
    logger.warn({ userId, err: error }, '[File] Error while verifying custom-drive file paths in getFiles');
  }

  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }

  // Cache the result (shorter TTL for file listings as they change frequently)
  await setCache(cacheKey, files, 60); // 1 minute TTL

  return files;
}

/**
 * Create a new folder
 */
async function createFolder(name, parentId = null, userId) {
  const id = generateId(16);

  // Check if user has custom drive enabled
  const customDrive = await getUserCustomDrive(userId);

  if (customDrive.enabled && customDrive.path) {
    let finalPath = null; // Declare outside try block to safely access in catch
    try {
      // Get the parent folder path
      const parentPath = await getFolderPath(parentId, userId);

      // Build the new folder path
      const folderPath = parentPath ? path.join(parentPath, name) : path.join(customDrive.path, name);

      // Handle duplicate folder names using utility function (via agent)
      finalPath = await getUniqueFolderPath(folderPath, true); // Use agent API

      // Create the folder via agent
      await agentMkdir(finalPath);

      // Get the actual folder name (in case it was changed due to duplicates)
      const actualName = path.basename(finalPath);

      // Store absolute path in database
      const absolutePath = path.resolve(finalPath);
      const result = await pool.query(
        'INSERT INTO files(id, name, type, parent_id, user_id, path) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
        [id, actualName, 'folder', parentId, userId, absolutePath]
      );

      // Invalidate cache
      await invalidateFileCache(userId, parentId);
      await invalidateSearchCache(userId);
      await deleteCache(cacheKeys.fileStats(userId));
      await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache

      return result.rows[0];
    } catch (error) {
      // If custom drive creation fails, clean up orphaned folder via agent
      logger.error('[File] Error creating folder in custom drive:', error);
      try {
        // Clean up the folder that was created via agent but not in database
        if (finalPath) {
          await agentDeletePath(finalPath).catch(() => {
            // Ignore cleanup errors (folder might not be empty or already deleted)
          });
        }
      } catch (cleanupError) {
        logger.warn(
          { finalPath, error: cleanupError.message },
          'Failed to clean up orphaned custom drive folder via agent'
        );
      }
      // Re-throw the error instead of falling back to avoid duplicate key errors
      throw error;
    }
  }

  // Regular folder creation (when custom drive is disabled or creation failed)
  const result = await pool.query(
    'INSERT INTO files(id, name, type, parent_id, user_id) VALUES($1,$2,$3,$4,$5) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'folder', parentId, userId]
  );

  // Invalidate cache for this user's file listings
  await invalidateFileCache(userId, parentId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));

  return result.rows[0];
}

/**
 * Create a new file
 */
async function createFile(name, size, mimeType, tempPath, parentId = null, userId, isAlreadyInFinalLocation = false) {
  const id = generateId(16);

  // Check if user has custom drive enabled
  const customDrive = await getUserCustomDrive(userId);

  // If custom drive is enabled, check if file is already in final location
  if (customDrive.enabled && customDrive.path && isAlreadyInFinalLocation && tempPath) {
    // File was streamed directly to final location by multer storage and handled duplicate names
    // Just update the database
    const finalPath = path.resolve(tempPath);
    const actualName = path.basename(finalPath);

    // Store absolute path in database
    // Use ON CONFLICT to handle case where file already exists in database
    const absolutePath = path.resolve(finalPath);
    const result = await pool.query(
      `INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (path, user_id, type) WHERE path IS NOT NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         size = EXCLUDED.size,
         mime_type = EXCLUDED.mime_type,
         parent_id = EXCLUDED.parent_id,
         modified = NOW()
       RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared`,
      [id, actualName, 'file', size, mimeType, absolutePath, parentId, userId]
    );

    // Invalidate cache
    await invalidateFileCache(userId, parentId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
    await deleteCache(cacheKeys.userStorage(userId));

    return result.rows[0];
  }

  // UNEXPECTED: Custom drive is enabled but file ended up in UPLOAD_DIR
  // This should NEVER happen with strict multer - multer fails hard instead of falling back
  // If this executes, something is wrong (bypass, race condition, or legacy code)
  if (customDrive.enabled && customDrive.path && !isAlreadyInFinalLocation) {
    logger.error(
      {
        userId,
        tempPath,
        name,
        customDrivePath: customDrive.path,
      },
      '[UNEXPECTED] Custom drive enabled but file in UPLOAD_DIR - this should not happen!'
    );

    // Fail immediately - don't try to recover
    // This prevents custom drive files from ever being in UPLOAD_DIR
    await safeUnlink(tempPath, { logErrors: true });
    throw new Error(
      'Upload failed: Custom drive is enabled but file ended up in temporary storage. This should not happen.'
    );
  }

  // Regular upload behavior (when custom drive is disabled)
  // File was uploaded to UPLOAD_DIR, rename to final storage name
  const ext = path.extname(name);
  const storageName = id + ext;
  const dest = path.join(UPLOAD_DIR, storageName);

  // Encrypt the file (custom_drive is disabled, so encrypt it)
  // Move temp file to temp location, then encrypt to final destination
  const tempDest = dest + '.tmp';
  await fs.promises.rename(tempPath, tempDest);
  try {
    await encryptFile(tempDest, dest);
  } catch (error) {
    logger.error('[File] Error encrypting file:', error);
    // If encryption fails, clean up temp file
    await safeUnlink(tempDest);
    throw new Error('Failed to encrypt file');
  }

  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'file', size, mimeType, storageName, parentId, userId]
  );

  // Invalidate cache
  await invalidateFileCache(userId, parentId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache

  return result.rows[0];
}

/**
 * Get a single file by ID
 */
async function getFile(id, userId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.file(id, userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query(
    'SELECT id, name, type, mime_type AS "mimeType", path, parent_id AS "parentId" FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [id, userId]
  );
  const file = result.rows[0];

  // Cache the result (5 minutes TTL)
  if (file) {
    await setCache(cacheKey, file, DEFAULT_TTL);
  }

  return file;
}

/**
 * Get multiple files by IDs (bulk operation)
 * @param {string[]} ids - Array of file IDs
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of file objects with id, name, type, mimeType, path, parentId
 */
async function getFilesByIds(ids, userId) {
  if (!ids || ids.length === 0) return [];

  // Try to get from cache first for all files (parallel)
  const cachePromises = ids.map(async id => {
    const cacheKey = cacheKeys.file(id, userId);
    const cached = await getCache(cacheKey);
    return { id, cached };
  });

  const cacheResultsArray = await Promise.all(cachePromises);
  const cacheResults = {};
  const uncachedIds = [];

  for (const { id, cached } of cacheResultsArray) {
    if (cached !== null) {
      cacheResults[id] = cached;
    } else {
      uncachedIds.push(id);
    }
  }

  // If all were cached, return immediately
  if (uncachedIds.length === 0) {
    return ids.map(id => cacheResults[id]).filter(Boolean);
  }

  // Query database for uncached items
  const result = await pool.query(
    'SELECT id, name, type, mime_type AS "mimeType", path, parent_id AS "parentId" FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL',
    [uncachedIds, userId]
  );

  // Cache all results in parallel
  const cacheSetPromises = result.rows.map(async file => {
    const cacheKey = cacheKeys.file(file.id, userId);
    await setCache(cacheKey, file, DEFAULT_TTL);
    cacheResults[file.id] = file;
  });
  await Promise.all(cacheSetPromises);

  // Return files in the same order as requested IDs
  return ids.map(id => cacheResults[id]).filter(Boolean);
}

/**
 * Rename a file or folder
 */
async function renameFile(id, name, userId) {
  // Get file info before renaming (need path and parent_id)
  const fileResult = await pool.query('SELECT path, parent_id, type FROM files WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (fileResult.rows.length === 0) {
    return null;
  }

  const oldFile = fileResult.rows[0];
  const parentId = oldFile.parent_id || null;

  // For custom drive files/folders, also rename on filesystem
  if (oldFile.path && path.isAbsolute(oldFile.path)) {
    const oldPath = path.resolve(oldFile.path);
    const newPath = path.join(path.dirname(oldPath), name);

    // Check if target already exists via agent
    const { agentPathExists, agentStatPath } = require('../../utils/agentFileOperations');
    const targetExists = await agentPathExists(newPath);
    if (targetExists) {
      throw new Error('File or folder with this name already exists');
    }

    // Rename via agent using OS-level rename (instant, even for large files)
    // STRICT: If agent operation fails, do NOT update database
    const stat = await agentStatPath(oldPath);
    if (stat.isDir) {
      // For folders, use rename endpoint (OS-level rename works for directories too)
      await agentRenamePath(oldPath, newPath);
    } else {
      // For files: use OS-level rename (instant, no copy needed)
      await agentRenamePath(oldPath, newPath);
    }

    // Only update database if agent operations succeeded
    await pool.query('UPDATE files SET name = $1, path = $2, modified = NOW() WHERE id = $3 AND user_id = $4', [
      name,
      path.resolve(newPath),
      id,
      userId,
    ]);
  } else {
    await pool.query('UPDATE files SET name = $1, modified = NOW() WHERE id = $2 AND user_id = $3', [name, id, userId]);
  }

  // Get updated file info
  const result = await pool.query(
    'SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files WHERE id = $1 AND user_id = $2',
    [id, userId]
  );

  // Invalidate cache
  await invalidateFileCache(userId, parentId);
  await invalidateSearchCache(userId);

  // Include parentId in the returned file object for event publishing
  const file = result.rows[0];
  if (file) {
    file.parentId = parentId;
  }

  return file;
}

module.exports = {
  getFiles,
  createFolder,
  createFile,
  getFile,
  getFilesByIds,
  renameFile,
};
