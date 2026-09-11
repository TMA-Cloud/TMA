import path from 'path';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import {
  getCache,
  getCaches,
  setCache,
  setCaches,
  deleteCache,
  cacheKeys,
  invalidateAllFileCaches,
  DEFAULT_TTL,
} from '../../utils/cache.js';
import { generateId } from '../../utils/id.js';
import storage from '../../utils/storageDriver.js';

import { buildKeysetPage, buildOrderClause, finishKeysetPage, getUniqueDbFileName } from './file.utils.model.js';

/**
 * Get files in a directory
 */
async function getFiles(userId, parentId = null, sortBy = 'modified', order = 'DESC', pageOptions = null) {
  const page = pageOptions
    ? buildKeysetPage(sortBy, order, pageOptions.cursor, 'f', parentId ? 3 : 2, pageOptions.limit)
    : null;
  const baseCacheKey = cacheKeys.files(userId, parentId, sortBy, order);
  const cacheKey = page ? `${baseCacheKey}:page:${pageOptions.cursor || 'first'}:${page.limit}` : baseCacheKey;
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const orderClause = page?.orderClause || buildOrderClause(sortBy, order, 'f');
  const baseParams = parentId ? [userId, parentId] : [userId];
  const result = await pool.query(
    `SELECT f.id, f.name, f.type,
            CASE WHEN f.type = 'folder' THEN f.aggregate_size ELSE f.size END AS size,
            f.modified, f.accessed_at AS "accessedAt", f.shared_at AS "sharedAt", f.mime_type AS "mimeType", f.starred, f.shared, f.path,
            CASE
              WHEN NOT f.shared OR share_info.has_perpetual THEN NULL
              ELSE share_info.expires_at
            END AS "expiresAt"
     FROM files f
     LEFT JOIN LATERAL (
       SELECT BOOL_OR(sl.expires_at IS NULL) AS has_perpetual,
              MAX(sl.expires_at) AS expires_at
         FROM share_link_files slf
         JOIN share_links sl ON sl.id = slf.share_id
        WHERE slf.file_id = f.id AND sl.user_id = $1
     ) share_info ON f.shared
     WHERE f.user_id = $1
       AND f.deleted_at IS NULL
       AND ${parentId ? 'f.parent_id = $2' : 'f.parent_id IS NULL'}
       ${page?.whereClause || ''}
     ${orderClause}
     ${page ? `LIMIT ${page.limitParam}` : ''}`,
    [...baseParams, ...(page?.params || [])]
  );
  const files = result.rows;

  const response = page ? finishKeysetPage(files, page) : files;
  await setCache(cacheKey, response, 60); // 1 minute TTL

  return response;
}

/**
 * Create a new folder
 * @param {string} name
 * @param {string|null} parentId
 * @param {string} userId
 * @param {Date|string|null} [modified] - Optional modification time (e.g. from directory mtime)
 */
async function createFolder(name, parentId = null, userId, modified = null, options = {}) {
  const id = generateId(16);
  if (options.importRunId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO files(id, name, type, parent_id, user_id, modified)
         VALUES($1,$2,'folder',$3,$4,COALESCE($5, NOW()))
         RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared`,
        [id, name, parentId, userId, modified]
      );
      await client.query(
        `INSERT INTO bulk_import_items(run_id, user_id, file_id, storage_name, item_type, depth)
         VALUES($1,$2,$3,NULL,'folder',$4)`,
        [options.importRunId, userId, id, options.importDepth || 0]
      );
      await client.query('COMMIT');
      await invalidateAllFileCaches(userId, parentId, { includeStorage: false });
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query(
      `SELECT storage_used, storage_reserved, storage_limit
         FROM users
        WHERE id = $1
        FOR UPDATE`,
      [userId]
    );
    if (account.rows.length === 0) throw new Error('Storage account not found');
    const used = Number(account.rows[0].storage_used) || 0;
    const limit = account.rows[0].storage_limit == null ? null : Number(account.rows[0].storage_limit);
    const reserved = Number(account.rows[0].storage_reserved) || 0;
    if (limit !== null && used + reserved + Number(size || 0) > limit) {
      const error = new Error('Storage limit exceeded');
      error.code = 'STORAGE_LIMIT_EXCEEDED';
      throw error;
    }

    const uniqueName = await getUniqueDbFileName(name, parentId, userId, client);
    const result = await client.query(
      `INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version)
       VALUES($1,$2,'file',$3,$4,$5,$6,$7,COALESCE($8, NOW()),$9,$10)
       RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared`,
      [id, uniqueName, size, mimeType, storageName, parentId, userId, modified, dekWrapped, dekKekVersion]
    );
    await client.query('COMMIT');
    await invalidateAllFileCaches(userId, parentId);
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function uploadNamePattern(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const escapeLike = value => value.replace(/([%_\\])/g, '\\$1');
  return { base, ext, pattern: `${escapeLike(base)} (%)${escapeLike(ext)}` };
}

/** Finalize streamed bulk uploads in one quota transaction and bounded inserts. */
async function createFilesFromStreamedUploads(entries, userId, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query(
      'SELECT storage_used, storage_reserved, storage_limit FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (account.rows.length === 0) throw new Error('Storage account not found');
    const addedBytes = entries.reduce((total, entry) => total + Number(entry.upload.size || 0), 0);
    const used = Number(account.rows[0].storage_used) || 0;
    const limit = account.rows[0].storage_limit == null ? null : Number(account.rows[0].storage_limit);
    const reserved = Number(account.rows[0].storage_reserved) || 0;
    if (limit !== null && used + reserved + addedBytes > limit) {
      const error = new Error('Storage limit exceeded');
      error.code = 'STORAGE_LIMIT_EXCEEDED';
      throw error;
    }

    const patterns = entries.map(entry => uploadNamePattern(entry.upload.name));
    const occupiedResult = await client.query(
      `WITH requested(idx, parent_id, desired, pattern) AS (
         SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[])
       )
       SELECT requested.idx, f.name
         FROM requested
         JOIN files f ON f.user_id = $5
          AND f.parent_id IS NOT DISTINCT FROM requested.parent_id
          AND f.type = 'file' AND f.deleted_at IS NULL
          AND (f.name = requested.desired OR f.name LIKE requested.pattern ESCAPE '\\')`,
      [
        entries.map((_, index) => index),
        entries.map(entry => entry.parentId),
        entries.map(entry => entry.upload.name),
        patterns.map(item => item.pattern),
        userId,
      ]
    );
    const occupiedByRequest = new Map();
    for (const row of occupiedResult.rows) {
      const names = occupiedByRequest.get(row.idx) || new Set();
      names.add(row.name.toLocaleLowerCase());
      occupiedByRequest.set(row.idx, names);
    }
    const occupiedByParent = new Map();
    const planned = entries.map((entry, index) => {
      const parentKey = entry.parentId || 'root';
      const batchNames = occupiedByParent.get(parentKey) || new Set();
      occupiedByParent.set(parentKey, batchNames);
      const occupied = new Set([...(occupiedByRequest.get(index) || []), ...batchNames]);
      const { base, ext } = patterns[index];
      let name = entry.upload.name;
      if (occupied.has(name.toLocaleLowerCase())) {
        let allocated = false;
        for (let counter = 1; counter <= 10000; counter += 1) {
          const candidate = `${base} (${counter})${ext}`;
          if (!occupied.has(candidate.toLocaleLowerCase())) {
            name = candidate;
            allocated = true;
            break;
          }
        }
        if (!allocated) throw new Error('Too many duplicate names in database');
      }
      batchNames.add(name.toLocaleLowerCase());
      return { ...entry, name };
    });

    const inserted = [];
    const columns = 11;
    for (let offset = 0; offset < planned.length; offset += 250) {
      const batch = planned.slice(offset, offset + 250);
      const values = [];
      const tuples = batch.map((entry, rowIndex) => {
        const upload = entry.upload;
        values.push(
          upload.id,
          entry.name,
          upload.size,
          upload.mimeType,
          upload.storageName,
          entry.parentId,
          userId,
          entry.modified,
          upload.dekWrapped ?? null,
          upload.dekKekVersion ?? null,
          entry.clientId ?? null
        );
        const start = rowIndex * columns + 1;
        return `($${start}::text,$${start + 1}::text,'file'::text,$${start + 2}::bigint,$${start + 3}::text,$${start + 4}::text,$${start + 5}::text,$${start + 6}::text,COALESCE($${start + 7}::timestamptz, NOW()),$${start + 8}::bytea,$${start + 9}::integer,$${start + 10}::text)`;
      });
      const result = await client.query(
        `WITH inserted AS (
           INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version)
           SELECT id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version
             FROM (VALUES ${tuples.join(',')}) AS incoming(id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version, client_id)
           RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared
         )
         SELECT inserted.*, incoming.client_id AS "clientId", incoming.parent_id AS "parentId"
           FROM inserted
           JOIN (VALUES ${tuples.join(',')}) AS incoming(id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version, client_id)
             ON incoming.id = inserted.id`,
        values
      );
      inserted.push(...result.rows);
    }
    if (options.importRunId) {
      await client.query(
        `INSERT INTO bulk_import_items(run_id, user_id, file_id, storage_name, item_type, depth)
         SELECT $1::uuid, $2::text, *
           FROM unnest($3::text[], $4::text[], $5::integer[])
                AS item(file_id, storage_name, depth)`,
        [
          options.importRunId,
          userId,
          planned.map(entry => entry.upload.id),
          planned.map(entry => entry.upload.storageName),
          planned.map(entry => entry.importDepth || 0),
        ]
      );
    }
    await client.query('COMMIT');
    await invalidateAllFileCaches(userId);
    const byId = new Map(inserted.map(row => [row.id, row]));
    return planned.map(entry => byId.get(entry.upload.id)).filter(Boolean);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
    'SELECT id, name, type, size, mime_type AS "mimeType", path, parent_id AS "parentId" FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
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
  const keys = ids.map(id => cacheKeys.file(id, userId));
  const cachedValues = await getCaches(keys);
  const cacheResults = {};
  const uncachedIds = [];

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const cached = cachedValues[index];
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
    'SELECT id, name, type, size, mime_type AS "mimeType", path, parent_id AS "parentId" FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL',
    [uncachedIds, userId]
  );

  // Cache all results in parallel
  for (const file of result.rows) {
    cacheResults[file.id] = file;
  }
  await setCaches(
    result.rows.map(file => [cacheKeys.file(file.id, userId), file]),
    DEFAULT_TTL
  );

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
    'SELECT id, name, type, size, modified, shared_at AS "sharedAt", mime_type AS "mimeType", starred, shared FROM files WHERE id = $1 AND user_id = $2',
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
  const client = await pool.connect();
  let oldFile;
  let file;
  try {
    await client.query('BEGIN');
    const account = await client.query(
      'SELECT storage_used, storage_reserved, storage_limit FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const fileResult = await client.query(
      'SELECT path, parent_id, size FROM files WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, userId]
    );
    if (fileResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    oldFile = fileResult.rows[0];
    const used = Number(account.rows[0]?.storage_used) || 0;
    const limit = account.rows[0]?.storage_limit == null ? null : Number(account.rows[0].storage_limit);
    const projected =
      used + Number(account.rows[0]?.storage_reserved || 0) - Number(oldFile.size || 0) + Number(size || 0);
    if (limit !== null && projected > limit) {
      const error = new Error('Storage limit exceeded');
      error.code = 'STORAGE_LIMIT_EXCEEDED';
      throw error;
    }

    const result = await client.query(
      'UPDATE files SET size = $1, mime_type = $2, path = $3, modified = COALESCE($4, NOW()), accessed_at = NOW(), dek_wrapped = $5, dek_kek_version = $6 WHERE id = $7 AND user_id = $8 RETURNING id, name, type, size, modified, accessed_at AS "accessedAt", mime_type AS "mimeType", starred, shared',
      [size, mimeType, newStorageKey, modified, dek.dekWrapped ?? null, dek.dekKekVersion ?? null, id, userId]
    );
    file = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const parentId = oldFile.parent_id || null;

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
  createFileFromStreamedUpload,
  createFilesFromStreamedUploads,
  findFolderIdByName,
  getFile,
  getFilesByIds,
  renameFile,
  replaceFileDataWithStorageKey,
};
