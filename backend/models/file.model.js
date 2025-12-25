const pool = require('../config/db');
const { generateId } = require('../utils/id');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');
const { resolveFilePath } = require('../utils/filePath');
const { logger } = require('../config/logger');
const { getUserCustomDriveSettings } = require('./user.model');
const {
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  cacheKeys,
  invalidateFileCache,
  invalidateSearchCache,
  DEFAULT_TTL,
} = require('../utils/cache');

/**
 * Invalidate custom drive cache for a specific user
 * Call this when custom drive settings are updated to ensure fresh data
 * @param {string} userId - User ID
 */
async function invalidateCustomDriveCache(userId) {
  await deleteCache(cacheKeys.customDrive(userId));
}

async function getUserCustomDrive(userId) {
  // Try to get from Redis cache first
  const cacheKey = cacheKeys.customDrive(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  try {
    const settings = await getUserCustomDriveSettings(userId);
    // Cache the result (1 minute TTL)
    await setCache(cacheKey, settings, 60);
    return settings;
  } catch (_error) {
    // If user not found or error, return disabled
    const defaultSettings = { enabled: false, path: null };
    // Cache the default to avoid repeated queries
    await setCache(cacheKey, defaultSettings, 60);
    return defaultSettings;
  }
}

const SORT_FIELDS = {
  name: 'name',
  size: 'size',
  modified: 'modified',
  deletedAt: 'deleted_at',
};

function buildOrderClause(sortBy = 'modified', order = 'DESC', tableAlias = null) {
  const field = SORT_FIELDS[sortBy] || 'modified';
  const dir = order && order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  // When sorting by size we will compute folder sizes dynamically. However,
  // keep NULL values (shouldn't exist after computing) last just in case.
  const nulls = field === 'size' ? ' NULLS LAST' : '';
  // Prefix field with table alias if provided (needed for JOIN queries to avoid ambiguity)
  const qualifiedField = tableAlias ? `${tableAlias}.${field}` : field;
  return `ORDER BY ${qualifiedField} ${dir}${nulls}`;
}

async function calculateFolderSize(id, userId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.folderSize(id, userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, size, type FROM files WHERE id = $1 AND user_id = $2
       UNION ALL
       SELECT f.id, f.size, f.type FROM files f
       JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2
     )
     SELECT COALESCE(SUM(size), 0) AS size FROM sub WHERE type = 'file'`,
    [id, userId]
  );
  const size = parseInt(res.rows[0].size, 10) || 0;

  // Cache the result (5 minutes TTL - folder sizes change less frequently)
  await setCache(cacheKey, size, DEFAULT_TTL);

  return size;
}

async function fillFolderSizes(files, userId) {
  await Promise.all(
    files.map(async f => {
      if (f.type === 'folder') {
        f.size = await calculateFolderSize(f.id, userId);
      }
    })
  );
  return files;
}

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

      // Handle duplicate folder names
      finalPath = folderPath;
      let counter = 1;
      while (
        await fs.promises
          .access(finalPath)
          .then(() => true)
          .catch(() => false)
      ) {
        const newName = `${name} (${counter})`;
        finalPath = parentPath ? path.join(parentPath, newName) : path.join(customDrive.path, newName);
        counter++;
        if (counter > 10000) {
          throw new Error('Too many duplicate folders');
        }
      }

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
 * Gets the folder path for a parent folder ID
 * Returns the absolute path if it's a custom drive folder, or null if regular folder
 */
async function getFolderPath(parentId, userId) {
  const customDrive = await getUserCustomDrive(userId);

  if (!parentId) {
    return customDrive.enabled && customDrive.path ? customDrive.path : null;
  }

  const result = await pool.query('SELECT path, type FROM files WHERE id = $1 AND user_id = $2', [parentId, userId]);

  if (result.rows.length === 0) {
    return customDrive.enabled && customDrive.path ? customDrive.path : null;
  }

  const folder = result.rows[0];

  // If it's a custom drive folder (has absolute path), use it
  if (folder.path && path.isAbsolute(folder.path)) {
    return folder.path;
  }

  // If custom drive is enabled but folder doesn't have path, use custom drive root
  // For regular folders, we'll need to build the path by traversing up
  if (customDrive.enabled && customDrive.path) {
    // Try to build path by traversing parent chain
    const folderPath = await buildFolderPath(parentId, userId);
    return folderPath || customDrive.path;
  }

  return null;
}

/**
 * Builds the folder path by traversing the parent chain
 */
async function buildFolderPath(folderId, userId) {
  const customDrive = await getUserCustomDrive(userId);

  if (!customDrive.enabled || !customDrive.path) {
    return null;
  }

  const pathParts = [];
  let currentId = folderId;

  // Traverse up the parent chain to build the path
  while (currentId) {
    const result = await pool.query('SELECT name, parent_id, path FROM files WHERE id = $1 AND user_id = $2', [
      currentId,
      userId,
    ]);

    if (result.rows.length === 0) break;

    const folder = result.rows[0];

    // If we hit a custom drive folder (has absolute path), use it as base
    if (folder.path && path.isAbsolute(folder.path)) {
      return folder.path;
    }

    pathParts.unshift(folder.name);
    currentId = folder.parent_id;

    // Safety check to avoid infinite loops
    if (pathParts.length > 100) break;
  }

  // Build path from custom drive root
  if (pathParts.length > 0) {
    return path.join(customDrive.path, ...pathParts);
  }

  return customDrive.path;
}

/**
 * Generates a unique filename if the file already exists
 */
async function getUniqueFilename(filePath, _folderPath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  let finalPath = filePath;
  let counter = 1;

  while (
    await fs.promises
      .access(finalPath)
      .then(() => true)
      .catch(() => false)
  ) {
    const newName = `${baseName} (${counter})${ext}`;
    finalPath = path.join(dir, newName);
    counter++;

    // Safety limit
    if (counter > 10000) {
      throw new Error('Too many duplicate files');
    }
  }

  return finalPath;
}

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

async function moveFiles(ids, parentId = null, userId) {
  // Get old parent IDs before moving
  const oldParentsResult = await pool.query(
    'SELECT DISTINCT parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
    [ids, userId]
  );
  const oldParentIds = oldParentsResult.rows.map(r => r.parent_id);

  await pool.query('UPDATE files SET parent_id = $1, modified = NOW() WHERE id = ANY($2::text[]) AND user_id = $3', [
    parentId,
    ids,
    userId,
  ]);

  // Invalidate cache for both old and new parent folders
  await invalidateFileCache(userId, parentId);
  for (const oldParentId of oldParentIds) {
    if (oldParentId !== parentId) {
      await invalidateFileCache(userId, oldParentId);
    }
  }
  await invalidateSearchCache(userId);
}

async function copyEntry(id, parentId, userId, client = null) {
  const dbClient = client || pool;
  const res = await dbClient.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (res.rows.length === 0) return null;
  const file = res.rows[0];
  const newId = generateId(16);
  let storageName = null;
  let newPath = null;

  if (file.type === 'file') {
    // Get source file path (handles both relative and absolute)
    const sourcePath = resolveFilePath(file.path);

    const customDrive = await getUserCustomDrive(userId);

    if (customDrive.enabled && customDrive.path) {
      // If custom drive is enabled, copy to custom drive with original name
      try {
        const folderPath = await getFolderPath(parentId, userId);
        const destDir = folderPath || customDrive.path;

        // Ensure destination directory exists
        try {
          await fs.promises.access(destDir);
        } catch {
          await fs.promises.mkdir(destDir, { recursive: true });
        }

        // Handle duplicate filenames
        let destPath = path.join(destDir, file.name);
        let counter = 1;
        while (
          await fs.promises
            .access(destPath)
            .then(() => true)
            .catch(() => false)
        ) {
          const ext = path.extname(file.name);
          const baseName = path.basename(file.name, ext);
          const newName = `${baseName} (${counter})${ext}`;
          destPath = path.join(destDir, newName);
          counter++;
          if (counter > 10000) {
            throw new Error('Too many duplicate files');
          }
        }

        await fs.promises.copyFile(sourcePath, destPath);
        newPath = path.resolve(destPath);

        // Get the actual filename (in case it was changed due to duplicates)
        const actualName = path.basename(destPath);

        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            actualName,
            file.type,
            file.size,
            file.mime_type,
            newPath,
            parentId,
            userId,
            file.starred,
            file.shared,
          ]
        );
      } catch (error) {
        // If custom drive copy fails, clean up orphaned file on disk
        logger.error('[File] Error copying file to custom drive:', error);
        try {
          // Clean up the file that was copied to disk but not in database
          if (newPath && path.isAbsolute(newPath)) {
            await fs.promises.unlink(newPath).catch(() => {
              // Ignore cleanup errors (file might not exist or already deleted)
            });
          }
        } catch (cleanupError) {
          logger.warn(
            { newPath, error: cleanupError.message },
            'Failed to clean up orphaned custom drive file during copy'
          );
        }
        // Re-throw the error instead of falling back to avoid violating custom drive invariant
        // Custom drive users must have all files in their custom drive path
        throw error;
      }
    } else {
      // Regular copy to UPLOAD_DIR
      const ext = path.extname(file.name);
      storageName = newId + ext;
      try {
        await fs.promises.copyFile(sourcePath, path.join(UPLOAD_DIR, storageName));
      } catch (error) {
        logger.error('Failed to copy file:', error);
        throw new Error('File copy operation failed');
      }
      newPath = storageName;

      await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId, file.name, file.type, file.size, file.mime_type, newPath, parentId, userId, file.starred, file.shared]
      );
    }
  } else if (file.type === 'folder') {
    // For folders created in custom drive, we need to create them on disk
    const customDrive = await getUserCustomDrive(userId);

    if (customDrive.enabled && customDrive.path) {
      let finalPath = null; // Declare outside try block to safely access in catch
      try {
        const parentPath = await getFolderPath(parentId, userId);
        const folderPath = parentPath ? path.join(parentPath, file.name) : path.join(customDrive.path, file.name);

        // Handle duplicate folder names
        finalPath = folderPath;
        let counter = 1;
        while (
          await fs.promises
            .access(finalPath)
            .then(() => true)
            .catch(() => false)
        ) {
          const newName = `${file.name} (${counter})`;
          finalPath = parentPath ? path.join(parentPath, newName) : path.join(customDrive.path, newName);
          counter++;
          if (counter > 10000) {
            throw new Error('Too many duplicate folders');
          }
        }

        await fs.promises.mkdir(finalPath, { recursive: true });
        const actualName = path.basename(finalPath);
        newPath = path.resolve(finalPath);

        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            actualName,
            file.type,
            file.size,
            file.mime_type,
            newPath,
            parentId,
            userId,
            file.starred,
            file.shared,
          ]
        );
      } catch (error) {
        // If custom drive folder creation fails, clean up orphaned folder on disk
        logger.error('[File] Error creating folder in custom drive during copy:', error);
        try {
          // Clean up the folder that was created on disk but not in database
          if (finalPath) {
            await fs.promises.rmdir(finalPath).catch(() => {
              // Ignore cleanup errors (folder might not be empty or already deleted)
            });
          }
        } catch (cleanupError) {
          logger.warn(
            { finalPath, error: cleanupError.message },
            'Failed to clean up orphaned custom drive folder during copy'
          );
        }
        // Re-throw the error instead of falling back to avoid duplicate key errors
        throw error;
      }
    } else {
      // Regular folder (no path stored)
      await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId, file.name, file.type, file.size, file.mime_type, null, parentId, userId, file.starred, file.shared]
      );
    }

    // Recursively copy folder contents
    const children = await dbClient.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [id, userId]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId, client);
    }
  }
  return newId;
}

async function copyFiles(ids, parentId = null, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      await copyEntry(id, parentId, userId, client);
    }
    await client.query('COMMIT');

    // Invalidate cache after copying
    await invalidateFileCache(userId, parentId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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

  return result.rows[0];
}

async function setStarred(ids, starred, userId) {
  await pool.query('UPDATE files SET starred = $1 WHERE id = ANY($2::text[]) AND user_id = $3', [starred, ids, userId]);

  // Invalidate cache (starred status affects file listings and stats)
  await invalidateFileCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  // Invalidate starred files cache
  await deleteCachePattern(`files:${userId}:starred:*`);
}

async function getRecursiveIds(ids, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM files WHERE id = ANY($1::text[]) AND user_id = $2
       UNION ALL
       SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2
     )
     SELECT id FROM sub`,
    [ids, userId]
  );
  return res.rows.map(r => r.id);
}

async function getFolderTree(folderId, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, name, type, path, parent_id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT f.id, f.name, f.type, f.path, f.parent_id FROM files f
       JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND f.deleted_at IS NULL
     )
     SELECT id, name, type, path, parent_id FROM sub`,
    [folderId, userId]
  );
  return res.rows;
}

async function setShared(ids, shared, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return [];
  const res = await pool.query(
    'UPDATE files SET shared = $1 WHERE id = ANY($2::text[]) AND user_id = $3 RETURNING id',
    [shared, allIds, userId]
  );

  // Invalidate cache (shared status affects file listings and stats)
  await invalidateFileCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  // Invalidate shared files cache
  await deleteCachePattern(`files:${userId}:shared:*`);

  return res.rows.map(r => r.id);
}

async function deleteFiles(ids, userId) {
  // Get parent IDs before deleting for cache invalidation
  const parentsResult = await pool.query(
    'SELECT DISTINCT parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
    [ids, userId]
  );
  const parentIds = parentsResult.rows.map(r => r.parent_id).filter(p => p !== null);

  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  await pool.query(
    'UPDATE files SET deleted_at = NOW() WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL',
    [allIds, userId]
  );

  // Invalidate cache for all affected parent folders
  await invalidateFileCache(userId);
  for (const parentId of parentIds) {
    await invalidateFileCache(userId, parentId);
    // Invalidate folder size cache for parent folders
    await deleteCache(cacheKeys.folderSize(parentId, userId));
  }
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  // Invalidate starred, shared, and trash caches
  await deleteCachePattern(`files:${userId}:starred:*`);
  await deleteCachePattern(`files:${userId}:shared:*`);
  await deleteCachePattern(`files:${userId}:trash:*`);
  // Invalidate folder size caches for deleted folders
  for (const id of allIds) {
    await deleteCachePattern(`folder:${userId}:${id}:*`);
  }
}

async function getTrashFiles(userId, sortBy = 'deletedAt', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const res = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared, deleted_at AS "deletedAt", parent_id AS "parentId" FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL ${orderClause}`,
    [userId]
  );
  const files = res.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

/**
 * Get all recursive IDs for files in trash (including children)
 */
async function getRecursiveTrashIds(ids, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NOT NULL
       UNION ALL
       SELECT f.id, f.parent_id FROM files f JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND f.deleted_at IS NOT NULL
     )
     SELECT id FROM sub`,
    [ids, userId]
  );
  return res.rows.map(r => r.id);
}

/**
 * Restore files from trash to their original location (or root if parent no longer exists)
 * Handles name conflicts by renaming restored files
 */
async function restoreFiles(ids, userId) {
  const allIds = await getRecursiveTrashIds(ids, userId);
  if (allIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all files to restore with their parent info
    const filesToRestore = await client.query(
      'SELECT id, name, type, parent_id, path FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NOT NULL',
      [allIds, userId]
    );

    // Process files in order: restore parents first, then children
    // Sort by parent_id nulls first, then by id to ensure consistent ordering
    const sortedFiles = filesToRestore.rows.sort((a, b) => {
      if (a.parent_id === null && b.parent_id !== null) return -1;
      if (a.parent_id !== null && b.parent_id === null) return 1;
      return a.id.localeCompare(b.id);
    });

    for (const file of sortedFiles) {
      let targetParentId = file.parent_id;

      // Check if parent still exists and is not deleted
      if (targetParentId) {
        const parentCheck = await client.query(
          'SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
          [targetParentId, userId]
        );

        // If parent doesn't exist or is deleted, restore to root
        if (parentCheck.rows.length === 0) {
          targetParentId = null;
        }
      }

      // Check for name conflicts in target location
      const conflictCheck = await client.query(
        'SELECT id, name FROM files WHERE name = $1 AND user_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL',
        [file.name, userId, targetParentId]
      );

      let finalName = file.name;
      if (conflictCheck.rows.length > 0) {
        // Name conflict exists, generate unique name
        const ext = path.extname(file.name);
        const baseName = path.basename(file.name, ext);
        let counter = 1;
        let nameExists = true;

        while (nameExists) {
          const newName = `${baseName} (${counter})${ext}`;
          const check = await client.query(
            'SELECT id FROM files WHERE name = $1 AND user_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL',
            [newName, userId, targetParentId]
          );
          if (check.rows.length === 0) {
            finalName = newName;
            nameExists = false;
          } else {
            counter++;
            if (counter > 10000) {
              throw new Error('Too many duplicate names');
            }
          }
        }
      }

      // Update name if it was changed due to conflict
      if (finalName !== file.name) {
        await client.query('UPDATE files SET name = $1 WHERE id = $2 AND user_id = $3', [finalName, file.id, userId]);
      }

      // Restore file: clear deleted_at and update parent_id
      await client.query(
        'UPDATE files SET deleted_at = NULL, parent_id = $1, modified = NOW() WHERE id = $2 AND user_id = $3',
        [targetParentId, file.id, userId]
      );
    }

    await client.query('COMMIT');

    // Invalidate cache after restore
    await invalidateFileCache(userId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function permanentlyDeleteFiles(ids, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  const files = await pool.query('SELECT id, path, type FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [
    allIds,
    userId,
  ]);

  // Delete files first, then folders
  const foldersToDelete = [];

  for (const f of files.rows) {
    if (!f.path) continue;

    try {
      if (f.type === 'file') {
        // Resolve file path (handles both relative and absolute paths)
        const filePath = resolveFilePath(f.path);
        await fs.promises.unlink(filePath);
      } else if (f.type === 'folder') {
        // For folders, we'll delete them after files are deleted
        // Only delete custom drive folders (those with absolute paths)
        if (path.isAbsolute(f.path)) {
          foldersToDelete.push(f.path);
        }
      }
    } catch (error) {
      // Log error but continue with other deletions
      logger.error(`[File] Error deleting ${f.type} ${f.path}:`, error.message);
    }
  }

  // Delete folders (in reverse order to handle nested folders)
  // Sort by path length descending so deeper folders are deleted first
  foldersToDelete.sort((a, b) => b.length - a.length);
  for (const folderPath of foldersToDelete) {
    try {
      // Check if folder is empty before deleting
      const contents = await fs.promises.readdir(folderPath);
      if (contents.length === 0) {
        await fs.promises.rmdir(folderPath);
      }
    } catch (error) {
      // Folder might not be empty or already deleted, skip
      logger.error(`[File] Error deleting folder ${folderPath}:`, error.message);
    }
  }

  await pool.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [allIds, userId]);

  // Invalidate cache after permanent deletion
  await invalidateFileCache(userId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
}

async function cleanupExpiredTrash() {
  const expired = await pool.query(
    "SELECT id, path, type FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'"
  );

  const foldersToDelete = [];

  for (const f of expired.rows) {
    if (!f.path) continue;

    try {
      if (f.type === 'file') {
        // Resolve file path (handles both relative and absolute paths)
        const filePath = resolveFilePath(f.path);
        await fs.promises.unlink(filePath);
      } else if (f.type === 'folder') {
        // For folders, collect them for deletion after files
        if (path.isAbsolute(f.path)) {
          foldersToDelete.push(f.path);
        }
      }
    } catch (error) {
      // Log error but continue
      logger.error(`[Trash] Error cleaning up ${f.type} ${f.path}:`, error.message);
    }
  }

  // Delete folders (in reverse order)
  foldersToDelete.sort((a, b) => b.length - a.length);
  for (const folderPath of foldersToDelete) {
    try {
      const contents = await fs.promises.readdir(folderPath);
      if (contents.length === 0) {
        await fs.promises.rmdir(folderPath);
      }
    } catch (error) {
      logger.error(`[Trash] Error deleting folder ${folderPath}:`, error.message);
    }
  }

  await pool.query("DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'");
}

async function cleanupOrphanFiles() {
  const uploadsDir = UPLOAD_DIR;
  let diskFiles = [];
  try {
    diskFiles = await fs.promises.readdir(uploadsDir);
  } catch {
    diskFiles = [];
  }
  const diskSet = new Set(diskFiles);

  // Only check files in UPLOAD_DIR, not custom drive files (which have absolute paths)
  const dbRes = await pool.query("SELECT id, path FROM files WHERE type = 'file' AND path IS NOT NULL");
  const dbSet = new Set();
  for (const row of dbRes.rows) {
    if (!row.path) continue;

    // Skip custom drive files (they have absolute paths, not relative to UPLOAD_DIR)
    if (path.isAbsolute(row.path)) {
      continue;
    }

    dbSet.add(row.path);
    // Only delete if it's a regular upload file (relative path) that doesn't exist on disk
    if (!diskSet.has(row.path)) {
      await pool.query('DELETE FROM files WHERE id = $1', [row.id]);
    }
  }

  // Clean up files on disk that aren't in database
  for (const file of diskFiles) {
    if (!dbSet.has(file)) {
      try {
        await fs.promises.unlink(path.join(uploadsDir, file));
      } catch {
        // Ignore deletion errors for orphan cleanup
      }
    }
  }
}

async function getStarredFiles(userId, sortBy = 'modified', order = 'DESC') {
  // Try to get from cache first
  const cacheKey = cacheKeys.starredFiles(userId, sortBy, order);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files WHERE user_id = $1 AND starred = TRUE AND deleted_at IS NULL ${orderClause}`,
    [userId]
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }

  // Cache the result (1 minute TTL)
  await setCache(cacheKey, files, 60);

  return files;
}

async function getSharedFiles(userId, sortBy = 'modified', order = 'DESC') {
  // Try to get from cache first
  const cacheKey = cacheKeys.sharedFiles(userId, sortBy, order);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order, 'f');
  // Only return top-level shared items (not children of shared folders)
  // A file is top-level shared if it's shared AND (has no parent OR parent is not shared)
  const result = await pool.query(
    `SELECT f.id, f.name, f.type, f.size, f.modified, f.mime_type AS "mimeType", f.starred, f.shared 
     FROM files f
     LEFT JOIN files parent ON f.parent_id = parent.id AND parent.user_id = $1
     WHERE f.user_id = $1 
       AND f.shared = TRUE 
       AND f.deleted_at IS NULL
       AND (f.parent_id IS NULL OR parent.shared = FALSE OR parent.shared IS NULL)
     ${orderClause}`,
    [userId]
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }

  // Cache the result (1 minute TTL)
  await setCache(cacheKey, files, 60);

  return files;
}

/**
 * Search files and folders using optimized trigram similarity
 * This uses PostgreSQL's pg_trgm extension for fast fuzzy text matching
 * Optimized for performance with smart query patterns based on query length
 * @param {string} userId - User ID to search files for
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 100)
 * @returns {Promise<Array>} Array of matching files
 */
async function searchFiles(userId, query, limit = 100) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const searchTerm = query.trim();
  const searchLength = searchTerm.length;

  // Try to get from cache first
  const cacheKey = cacheKeys.search(userId, searchTerm, limit);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // For very short queries (1-2 chars), use prefix matching only for better performance
  // For longer queries, use trigram similarity for fuzzy matching
  // Use optimized query patterns to leverage GIN indexes effectively
  let sqlQuery;
  let queryParams;

  if (searchLength <= 2) {
    // Short queries: Use prefix matching (index-friendly)
    // This avoids expensive trigram calculations for very short queries
    sqlQuery = `
      SELECT 
        id, 
        name, 
        type, 
        size, 
        modified, 
        mime_type AS "mimeType", 
        starred, 
        shared,
        parent_id AS "parentId"
      FROM files 
      WHERE user_id = $1 
        AND deleted_at IS NULL
        AND lower(name) LIKE lower($2) || '%'
      ORDER BY 
        CASE
          WHEN lower(name) = lower($2) THEN 1
          ELSE 2
        END ASC,
        name ASC,
        modified DESC
      LIMIT $3
    `;
    queryParams = [userId, searchTerm, limit];
  } else {
    // Longer queries: Use trigram similarity for fuzzy matching
    // Optimized to use index scans where possible
    sqlQuery = `
      SELECT 
        id, 
        name, 
        type, 
        size, 
        modified, 
        mime_type AS "mimeType", 
        starred, 
        shared,
        parent_id AS "parentId"
      FROM files 
      WHERE user_id = $1 
        AND deleted_at IS NULL
        AND (
          -- Prefix match (fast with index)
          lower(name) LIKE lower($2) || '%'
          OR 
          -- Full text match (uses trigram index)
          (lower(name) LIKE '%' || lower($2) || '%' AND similarity(lower(name), lower($2)) > 0.15)
        )
      ORDER BY 
        CASE
          WHEN lower(name) = lower($2) THEN 1
          WHEN lower(name) LIKE lower($2) || '%' THEN 2
          ELSE 3
        END ASC,
        similarity(lower(name), lower($2)) DESC NULLS LAST,
        modified DESC
      LIMIT $3
    `;
    queryParams = [userId, searchTerm, limit];
  }

  const result = await pool.query(sqlQuery, queryParams);
  const files = result.rows;

  // Fill folder sizes for folders (only if needed, in batches)
  await fillFolderSizes(files, userId);

  // Cache the result (shorter TTL for search results)
  await setCache(cacheKey, files, 120); // 2 minutes TTL

  return files;
}

/**
 * Get file statistics for a user
 * Returns total counts of files, folders, shared items, and starred items
 * @param {string} userId - User ID to get stats for
 * @returns {Promise<Object>} Object with totalFiles, totalFolders, sharedCount, starredCount
 */
async function getFileStats(userId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.fileStats(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query(
    `SELECT 
      COUNT(*) FILTER (WHERE f.type = 'file' AND f.deleted_at IS NULL) AS "totalFiles",
      COUNT(*) FILTER (WHERE f.type = 'folder' AND f.deleted_at IS NULL) AS "totalFolders",
      COUNT(*) FILTER (
        WHERE f.shared = TRUE 
        AND f.deleted_at IS NULL
        AND (f.parent_id IS NULL OR parent.shared = FALSE OR parent.shared IS NULL)
      ) AS "sharedCount",
      COUNT(*) FILTER (WHERE f.starred = TRUE AND f.deleted_at IS NULL) AS "starredCount"
     FROM files f
     LEFT JOIN files parent ON f.parent_id = parent.id AND parent.user_id = $1
     WHERE f.user_id = $1`,
    [userId]
  );

  const stats = {
    totalFiles: parseInt(result.rows[0].totalFiles, 10) || 0,
    totalFolders: parseInt(result.rows[0].totalFolders, 10) || 0,
    sharedCount: parseInt(result.rows[0].sharedCount, 10) || 0,
    starredCount: parseInt(result.rows[0].starredCount, 10) || 0,
  };

  // Cache the result
  await setCache(cacheKey, stats, DEFAULT_TTL);

  return stats;
}

module.exports = {
  getUserCustomDrive,
  invalidateCustomDriveCache,
  getFiles,
  createFolder,
  createFile,
  moveFiles,
  copyFiles,
  getFile,
  renameFile,
  setStarred,
  getStarredFiles,
  setShared,
  getRecursiveIds,
  getFolderTree,
  getSharedFiles,
  deleteFiles,
  getTrashFiles,
  restoreFiles,
  permanentlyDeleteFiles,
  cleanupExpiredTrash,
  cleanupOrphanFiles,
  searchFiles,
  getFileStats,
};
