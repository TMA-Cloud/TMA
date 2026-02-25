const pool = require('../../config/db');
const {
  invalidateFileCache,
  deleteCache,
  deleteCachePattern,
  cacheKeys,
  getCache,
  setCache,
} = require('../../utils/cache');
const { fillFolderSizes, buildOrderClause } = require('./file.utils.model');

/**
 * Set starred status for files
 */
async function setStarred(ids, starred, userId) {
  await pool.query('UPDATE files SET starred = $1 WHERE id = ANY($2::text[]) AND user_id = $3', [starred, ids, userId]);

  // Invalidate cache (starred status affects file listings and stats)
  await invalidateFileCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache
  // Invalidate starred files cache
  await deleteCachePattern(`files:${userId}:starred:*`);
}

/**
 * Get starred files
 */
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

/**
 * Set shared status for files (recursively)
 */
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
  await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache
  // Invalidate shared files cache
  await deleteCachePattern(`files:${userId}:shared:*`);

  return res.rows.map(r => r.id);
}

/**
 * Get shared files (top-level only), including share link expiry info
 */
async function getSharedFiles(userId, sortBy = 'modified', order = 'DESC') {
  const cacheKey = cacheKeys.sharedFiles(userId, sortBy, order);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order, 'f');
  const result = await pool.query(
    `SELECT f.id, f.name, f.type, f.size, f.modified, f.mime_type AS "mimeType",
            f.starred, f.shared,
            s.expires_at AS "expiresAt"
     FROM files f
     LEFT JOIN files parent ON f.parent_id = parent.id AND parent.user_id = $1
     LEFT JOIN share_links s ON s.file_id = f.id AND s.user_id = $1
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

  await setCache(cacheKey, files, 60);

  return files;
}

/**
 * Get all recursive IDs for files (including children)
 */
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

/**
 * Get folder tree (all files and folders recursively)
 */
async function getFolderTree(folderId, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, name, type, path, size, parent_id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT f.id, f.name, f.type, f.path, f.size, f.parent_id FROM files f
       JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND f.deleted_at IS NULL
     )
     SELECT id, name, type, path, size, parent_id FROM sub`,
    [folderId, userId]
  );
  return res.rows;
}

module.exports = {
  setStarred,
  getStarredFiles,
  setShared,
  getSharedFiles,
  getRecursiveIds,
  getFolderTree,
};
