const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { safeUnlink } = require('../../utils/fileCleanup');
const { generateId } = require('../../utils/id');
const { UPLOAD_DIR } = require('../../config/paths');
const { resolveFilePath } = require('../../utils/filePath');
const storage = require('../../utils/storageDriver');
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
const { buildOrderClause, fillFolderSizes, getUniqueDbFileName } = require('./file.utils.model');
const { encryptFile } = require('../../utils/fileEncryption');

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
 * @param {string} name
 * @param {string|null} parentId
 * @param {string} userId
 * @param {Date|string|null} [modified] - Optional modification time (e.g. from directory mtime)
 */
async function createFolder(name, parentId = null, userId, modified = null) {
  const id = generateId(16);

  if (modified != null) {
    const result = await pool.query(
      'INSERT INTO files(id, name, type, parent_id, user_id, modified) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
      [id, name, 'folder', parentId, userId, modified]
    );
    await invalidateFileCache(userId, parentId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
    return result.rows[0];
  }

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
 * Create a new file (local: from multer temp path; S3: use createFileFromStreamedUpload instead).
 * When S3 is enabled, uploads go via stream middleware and createFileFromStreamedUpload — no temp dir.
 */
async function createFile(name, size, mimeType, tempPath, parentId = null, userId) {
  const id = generateId(16);
  const ext = path.extname(name);
  const storageName = id + ext;

  if (storage.useS3()) {
    throw new Error('createFile with temp path is not used when S3 is enabled; use createFileFromStreamedUpload');
  }

  {
    const dest = path.join(UPLOAD_DIR, storageName);
    const tempDest = dest + '.tmp';
    await fs.promises.rename(tempPath, tempDest);
    try {
      await encryptFile(tempDest, dest);
    } catch (error) {
      logger.error('[File] Error encrypting file:', error);
      await safeUnlink(tempDest);
      throw new Error('Failed to encrypt file', { cause: error });
    }
  }

  const uniqueName = await getUniqueDbFileName(name, parentId, userId);
  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, uniqueName, 'file', size, mimeType, storageName, parentId, userId]
  );

  // Invalidate cache
  await invalidateFileCache(userId, parentId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache

  return result.rows[0];
}

/**
 * Create file record after streamed upload to S3 (no temp file; stream was piped directly to bucket).
 * @param {Object} upload - { id, storageName, name, size, mimeType, modified? }
 * @param {string|null} parentId
 * @param {string} userId
 * @returns {Promise<Object>} Created file row
 */
async function createFileFromStreamedUpload(upload, parentId, userId) {
  const { id, storageName, name, size, mimeType, modified } = upload;
  const uniqueName = await getUniqueDbFileName(name, parentId, userId);

  if (modified != null) {
    const result = await pool.query(
      'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
      [id, uniqueName, 'file', size, mimeType, storageName, parentId, userId, modified]
    );
    await invalidateFileCache(userId, parentId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
    await deleteCache(cacheKeys.userStorage(userId));
    return result.rows[0];
  }

  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, uniqueName, 'file', size, mimeType, storageName, parentId, userId]
  );

  await invalidateFileCache(userId, parentId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  await deleteCache(cacheKeys.userStorage(userId));

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
  const fileResult = await pool.query('SELECT path, parent_id, type FROM files WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (fileResult.rows.length === 0) {
    return null;
  }

  const oldFile = fileResult.rows[0];
  const parentId = oldFile.parent_id || null;

  if (oldFile.path) {
    if (storage.useS3()) {
      const newKey = name;
      try {
        const keyExists = await storage.exists(newKey);
        if (keyExists) {
          throw new Error('File or folder with this name already exists');
        }
        await storage.copyObject(oldFile.path, newKey);
        await storage.deleteObject(oldFile.path);
        await pool.query('UPDATE files SET name = $1, path = $2 WHERE id = $3 AND user_id = $4', [
          name,
          newKey,
          id,
          userId,
        ]);
      } catch (err) {
        if (err.message && err.message.includes('already exists')) throw err;
        logger.warn({ err, id, path: oldFile.path }, '[File] S3 rename failed, updating name only');
        await pool.query('UPDATE files SET name = $1 WHERE id = $2 AND user_id = $3', [name, id, userId]);
      }
    } else {
      const oldPath = resolveFilePath(oldFile.path);
      const newPath = path.join(path.dirname(oldPath), name);

      try {
        const targetExists = await fs.promises
          .access(newPath)
          .then(() => true)
          .catch(() => false);
        if (targetExists) {
          throw new Error('File or folder with this name already exists');
        }
        await fs.promises.rename(oldPath, newPath);
        const newPathForDb = path.basename(newPath);
        await pool.query('UPDATE files SET name = $1, path = $2 WHERE id = $3 AND user_id = $4', [
          name,
          newPathForDb,
          id,
          userId,
        ]);
      } catch (err) {
        if (err.code === 'ENOENT') {
          await pool.query('UPDATE files SET name = $1 WHERE id = $2 AND user_id = $3', [name, id, userId]);
        } else {
          throw err;
        }
      }
    }
  } else {
    await pool.query('UPDATE files SET name = $1 WHERE id = $2 AND user_id = $3', [name, id, userId]);
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

async function replaceFileData(id, size, mimeType, tempPath, userId) {
  const fileResult = await pool.query('SELECT path, parent_id, type FROM files WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (fileResult.rows.length === 0) {
    await safeUnlink(tempPath);
    return null;
  }

  const oldFile = fileResult.rows[0];
  const parentId = oldFile.parent_id || null;

  if (!oldFile.path) {
    await safeUnlink(tempPath);
    return null;
  }

  if (storage.useS3()) {
    const readStream = fs.createReadStream(tempPath);
    const { createEncryptStream } = require('../../utils/fileEncryption');
    const encryptStream = createEncryptStream();
    readStream.pipe(encryptStream);
    try {
      await storage.putStream(oldFile.path, encryptStream);
    } finally {
      readStream.destroy();
      await safeUnlink(tempPath);
    }
  } else {
    const dest = resolveFilePath(oldFile.path);
    const tempDest = dest + '.tmp';
    try {
      await fs.promises.rename(tempPath, tempDest);
    } catch (err) {
      // On Windows, EPERM/EACCES can happen if the destination is locked or already exists.
      // EXDEV occurs when crossing device/drive boundaries (e.g. C: -> D:).
      // Fall back to copy + unlink to avoid leaving the original temp file around.
      if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EXDEV')) {
        await fs.promises.copyFile(tempPath, tempDest);
        await safeUnlink(tempPath);
      } else {
        await safeUnlink(tempPath);
        throw err;
      }
    }
    try {
      await encryptFile(tempDest, dest);
    } catch (error) {
      logger.error('[File] Error encrypting file on replace:', error);
      await safeUnlink(tempDest);
      throw new Error('Failed to encrypt file', { cause: error });
    }
  }

  const result = await pool.query(
    'UPDATE files SET size = $1, mime_type = $2, modified = NOW() WHERE id = $3 AND user_id = $4 RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [size, mimeType, id, userId]
  );

  await invalidateFileCache(userId, parentId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  await deleteCache(cacheKeys.userStorage(userId));

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
  createFileFromStreamedUpload,
  getFile,
  getFilesByIds,
  renameFile,
  replaceFileData,
};
