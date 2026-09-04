import fs from 'fs';
import path from 'path';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { UPLOAD_DIR } from '../../config/paths.js';
import { getCache, setCache, deleteCache, cacheKeys, invalidateAllFileCaches, DEFAULT_TTL } from '../../utils/cache.js';
import { safeUnlink } from '../../utils/fileCleanup.js';
import { createEncryptStream, encryptFile, newWrappedDek } from '../../utils/fileEncryption.js';
import { resolveFilePath } from '../../utils/filePath.js';
import { generateId } from '../../utils/id.js';
import storage from '../../utils/storageDriver.js';

import { buildOrderClause, fillFolderSizes, getUniqueDbFileName } from './file.utils.model.js';

/**
 * Get files in a directory
 */
async function getFiles(userId, parentId = null, sortBy = 'modified', order = 'DESC') {
  const cacheKey = cacheKeys.files(userId, parentId, sortBy, order);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, accessed_at AS "accessedAt", mime_type AS "mimeType", starred, shared, path
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
    await invalidateAllFileCaches(userId, parentId, { includeStorage: false });
    return result.rows[0];
  }

  const result = await pool.query(
    'INSERT INTO files(id, name, type, parent_id, user_id) VALUES($1,$2,$3,$4,$5) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'folder', parentId, userId]
  );

  // Invalidate cache for this user's file listings
  await invalidateAllFileCaches(userId, parentId, { includeStorage: false });

  return result.rows[0];
}

/**
 * Create a new file (local: from multer temp path; S3: use createFileFromStreamedUpload instead).
 * When S3 is enabled, uploads go via stream middleware and createFileFromStreamedUpload — no temp dir.
 * @param {Date|string|null} [modified] - Client's mtime; omit to stamp the row with the upload time.
 */
async function createFile(name, size, mimeType, tempPath, parentId = null, userId, modified = null) {
  const id = generateId(16);
  const ext = path.extname(name);
  const storageName = id + ext;

  if (storage.useS3()) {
    throw new Error('createFile with temp path is not used when S3 is enabled; use createFileFromStreamedUpload');
  }

  // Envelope encryption: encrypt the body under its own DEK and persist the
  // wrapped DEK on the row.
  const dekInfo = newWrappedDek();

  {
    const dest = path.join(UPLOAD_DIR, storageName);
    const tempDest = dest + '.tmp';
    await fs.promises.rename(tempPath, tempDest);
    try {
      await encryptFile(tempDest, dest, dekInfo.dek);
    } catch (error) {
      logger.error('[File] Error encrypting file:', error);
      await safeUnlink(tempDest);
      throw new Error('Failed to encrypt file', { cause: error });
    }
  }

  const dekWrapped = dekInfo.dekWrapped;
  const dekKekVersion = dekInfo.kekVersion;
  const uniqueName = await getUniqueDbFileName(name, parentId, userId);
  const result =
    modified != null
      ? await pool.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
          [id, uniqueName, 'file', size, mimeType, storageName, parentId, userId, modified, dekWrapped, dekKekVersion]
        )
      : await pool.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, dek_wrapped, dek_kek_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
          [id, uniqueName, 'file', size, mimeType, storageName, parentId, userId, dekWrapped, dekKekVersion]
        );

  // Invalidate cache
  await invalidateAllFileCaches(userId, parentId);

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
  // The stream middleware minted and wrapped the DEK while piping to storage.
  const dekWrapped = upload.dekWrapped ?? null;
  const dekKekVersion = upload.dekKekVersion ?? null;
  const uniqueName = await getUniqueDbFileName(name, parentId, userId);

  if (modified != null) {
    const result = await pool.query(
      'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
      [id, uniqueName, 'file', size, mimeType, storageName, parentId, userId, modified, dekWrapped, dekKekVersion]
    );
    await invalidateAllFileCaches(userId, parentId);
    return result.rows[0];
  }

  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, dek_wrapped, dek_kek_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, uniqueName, 'file', size, mimeType, storageName, parentId, userId, dekWrapped, dekKekVersion]
  );

  await invalidateAllFileCaches(userId, parentId);

  return result.rows[0];
}

/**
 * Get a single file by ID
 */
async function getFile(id, userId) {
  const cacheKey = cacheKeys.file(id, userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query(
    'SELECT id, name, type, mime_type AS "mimeType", path, parent_id AS "parentId" FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [id, userId]
  );
  const file = result.rows[0];

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

  // Rename touches only the logical metadata; the storage key/path stays stable
  // so real names never leak into bucket keys or disk paths.
  await pool.query('UPDATE files SET name = $1, modified = NOW() WHERE id = $2 AND user_id = $3', [name, id, userId]);

  // Get updated file info
  const result = await pool.query(
    'SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files WHERE id = $1 AND user_id = $2',
    [id, userId]
  );

  // Invalidate cache (rename doesn't affect size, so skip stats/storage)
  await invalidateAllFileCaches(userId, parentId, { includeStats: false, includeStorage: false });

  // Include parentId in the returned file object for event publishing
  const file = result.rows[0];
  if (file) {
    file.parentId = parentId;
  }

  return file;
}

async function replaceFileData(id, size, mimeType, tempPath, userId, modified = null) {
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

  // Replacing the body re-keys it: give the new content its own DEK.
  const dekInfo = newWrappedDek();

  if (storage.useS3()) {
    const readStream = fs.createReadStream(tempPath);
    const encryptStream = createEncryptStream(dekInfo.dek);
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
      // Windows can EPERM/EACCES (locked/existing dest) or EXDEV (cross-drive);
      // fall back to copy + unlink so no temp file is left behind.
      if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EXDEV')) {
        await fs.promises.copyFile(tempPath, tempDest);
        await safeUnlink(tempPath);
      } else {
        await safeUnlink(tempPath);
        throw err;
      }
    }
    try {
      await encryptFile(tempDest, dest, dekInfo.dek);
    } catch (error) {
      logger.error('[File] Error encrypting file on replace:', error);
      await safeUnlink(tempDest);
      throw new Error('Failed to encrypt file', { cause: error });
    }
  }

  // A write also counts as access (like NTFS). We stamp accessed_at; modified
  // defers to the replacing file's mtime when the client sent one. The body was
  // re-keyed, so the wrapped-DEK columns move with it.
  const result = await pool.query(
    'UPDATE files SET size = $1, mime_type = $2, modified = COALESCE($3, NOW()), accessed_at = NOW(), dek_wrapped = $4, dek_kek_version = $5 WHERE id = $6 AND user_id = $7 RETURNING id, name, type, size, modified, accessed_at AS "accessedAt", mime_type AS "mimeType", starred, shared',
    [size, mimeType, modified, dekInfo.dekWrapped, dekInfo.kekVersion, id, userId]
  );

  await invalidateAllFileCaches(userId, parentId);

  const file = result.rows[0];
  if (file) {
    file.parentId = parentId;
  }

  return file;
}

/**
 * S3 replace: new bytes already streamed to `newStorageKey` (no temp file).
 * Point the DB row at it, then best-effort delete the old object.
 * @param {string} id - File id
 * @param {number} size - New file size (plaintext bytes)
 * @param {string} mimeType - Detected MIME type
 * @param {string} newStorageKey - Storage key the new bytes were streamed to
 * @param {string} userId - Owner id
 * @param {Date|null} [modified] - Replacing file's mtime; omit to stamp with now
 * @returns {Promise<Object|null>} Updated file row, or null if not found
 */
async function replaceFileDataWithStorageKey(id, size, mimeType, newStorageKey, userId, modified = null, dek = {}) {
  const fileResult = await pool.query('SELECT path, parent_id FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (fileResult.rows.length === 0) {
    return null;
  }

  const oldFile = fileResult.rows[0];
  const parentId = oldFile.parent_id || null;

  // The stream middleware already wrapped the DEK for the new bytes (null when
  // envelope encryption is off); the new object carries its own key.
  const result = await pool.query(
    'UPDATE files SET size = $1, mime_type = $2, path = $3, modified = COALESCE($4, NOW()), accessed_at = NOW(), dek_wrapped = $5, dek_kek_version = $6 WHERE id = $7 AND user_id = $8 RETURNING id, name, type, size, modified, accessed_at AS "accessedAt", mime_type AS "mimeType", starred, shared',
    [size, mimeType, newStorageKey, modified, dek.dekWrapped ?? null, dek.dekKekVersion ?? null, id, userId]
  );

  const file = result.rows[0];
  if (!file) {
    return null;
  }

  // Drop the old object (best-effort).
  if (oldFile.path && oldFile.path !== newStorageKey) {
    storage
      .deleteObject(oldFile.path)
      .catch(err =>
        logger.warn({ err, storageName: oldFile.path }, '[File] Failed to delete old object after replace')
      );
  }

  // Clear the cached file record or downloads 404 on the old path until TTL.
  await deleteCache(cacheKeys.file(id, userId));
  await invalidateAllFileCaches(userId, parentId);

  file.parentId = parentId;
  return file;
}

/**
 * Find an existing folder by name under a parent (or root).
 * Returns the folder id if found, otherwise null.
 */
async function findFolderIdByName(name, parentId = null, userId) {
  const result = await pool.query(
    `SELECT id
     FROM files
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND type = 'folder'
       AND name = $2
       AND parent_id IS NOT DISTINCT FROM $3
     LIMIT 1`,
    [userId, name, parentId]
  );
  return result.rows[0]?.id || null;
}

export {
  getFiles,
  createFolder,
  createFile,
  createFileFromStreamedUpload,
  findFolderIdByName,
  getFile,
  getFilesByIds,
  renameFile,
  replaceFileData,
  replaceFileDataWithStorageKey,
};
