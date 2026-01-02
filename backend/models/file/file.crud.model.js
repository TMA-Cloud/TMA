const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
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
const {
  buildOrderClause,
  fillFolderSizes,
  getFolderPath,
  getUniqueFilename,
  getUniqueFolderPath,
} = require('./file.utils.model');

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
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared
     FROM files
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}
     ${orderClause}`,
    parentId ? [userId, parentId] : [userId]
  );
  const files = result.rows;
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

      // Handle duplicate folder names using utility function
      finalPath = await getUniqueFolderPath(folderPath);

      // Create the folder on disk
      await fs.promises.mkdir(finalPath, { recursive: true });

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

      return result.rows[0];
    } catch (error) {
      // If custom drive creation fails, clean up orphaned folder on disk
      logger.error('[File] Error creating folder in custom drive:', error);
      try {
        // Clean up the folder that was created on disk but not in database
        if (finalPath) {
          await fs.promises.rmdir(finalPath).catch(() => {
            // Ignore cleanup errors (folder might not be empty or already deleted)
          });
        }
      } catch (cleanupError) {
        logger.warn({ finalPath, error: cleanupError.message }, 'Failed to clean up orphaned custom drive folder');
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
async function createFile(name, size, mimeType, tempPath, parentId = null, userId) {
  const id = generateId(16);

  // Check if user has custom drive enabled
  const customDrive = await getUserCustomDrive(userId);

  // If custom drive is enabled, file is already uploaded directly to custom drive path
  // Just rename it to the final location with proper name (same filesystem, so rename works)
  if (customDrive.enabled && customDrive.path) {
    let finalPath = null;
    let renameSucceeded = false; // Track whether rename actually succeeded
    try {
      // Get the target folder path
      const folderPath = await getFolderPath(parentId, userId);

      // Ensure the target folder exists
      const targetDir = folderPath || customDrive.path;
      try {
        await fs.promises.access(targetDir);
      } catch {
        // Folder doesn't exist, create it
        await fs.promises.mkdir(targetDir, { recursive: true });
      }

      // Build the destination path with original filename
      const destPath = path.join(targetDir, name);

      // Handle duplicate filenames
      finalPath = await getUniqueFilename(destPath, targetDir);

      // Rename temp file to final location (same filesystem since multer uploaded directly to custom drive)
      await fs.promises.rename(tempPath, finalPath);
      renameSucceeded = true; // Mark that rename succeeded

      // Get the actual filename (in case it was changed due to duplicates)
      const actualName = path.basename(finalPath);

      // Store absolute path in database
      const absolutePath = path.resolve(finalPath);
      const result = await pool.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
        [id, actualName, 'file', size, mimeType, absolutePath, parentId, userId]
      );

      // Invalidate cache
      await invalidateFileCache(userId, parentId);
      await invalidateSearchCache(userId);
      await deleteCache(cacheKeys.fileStats(userId));

      return result.rows[0];
    } catch (error) {
      // If custom drive save fails, log and throw (don't fall back since file is already in custom drive)
      logger.error('[File] Error saving to custom drive:', error);
      // Clean up the orphaned file based on whether rename succeeded
      try {
        if (renameSucceeded && finalPath) {
          // Rename succeeded, so file is at finalPath - delete it
          await fs.promises.unlink(finalPath);
        } else if (finalPath) {
          // Rename failed or didn't happen, but finalPath was set
          // Try finalPath first (in case rename partially succeeded), then tempPath
          try {
            await fs.promises.unlink(finalPath);
          } catch {
            // finalPath doesn't exist, try tempPath
            await fs.promises.unlink(tempPath);
          }
        } else {
          // finalPath wasn't set, file is still at tempPath
          await fs.promises.unlink(tempPath);
        }
      } catch (cleanupError) {
        logger.warn(
          { finalPath, tempPath, renameSucceeded, error: cleanupError.message },
          'Failed to clean up orphaned custom drive file'
        );
      }
      throw error;
    }
  }

  // Regular upload behavior (when custom drive is disabled)
  // File was uploaded to UPLOAD_DIR, rename to final storage name
  const ext = path.extname(name);
  const storageName = id + ext;
  const dest = path.join(UPLOAD_DIR, storageName);
  await fs.promises.rename(tempPath, dest);
  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'file', size, mimeType, storageName, parentId, userId]
  );

  // Invalidate cache
  await invalidateFileCache(userId, parentId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));

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
    'SELECT id, name, type, mime_type AS "mimeType", path FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
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
 * Rename a file or folder
 */
async function renameFile(id, name, userId) {
  // Get parent ID before renaming for cache invalidation
  const fileResult = await pool.query('SELECT parent_id FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  const parentId = fileResult.rows[0]?.parent_id || null;

  const result = await pool.query(
    'UPDATE files SET name = $1, modified = NOW() WHERE id = $2 AND user_id = $3 RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [name, id, userId]
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
  renameFile,
};
