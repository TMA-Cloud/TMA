const pool = require('../config/db');
const { generateId } = require('../utils/id');
const { getCache, setCache, deleteCache, cacheKeys, invalidateShareCache, DEFAULT_TTL } = require('../utils/cache');

async function createShareLink(fileId, userId, fileIds = [fileId]) {
  // Use 16-character tokens for ~93 bits of entropy (same as file IDs)
  // This makes brute-force attacks computationally infeasible
  const id = generateId(16);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO share_links(id, file_id, user_id) VALUES($1,$2,$3)', [id, fileId, userId]);
    await client.query('INSERT INTO share_link_files(share_id, file_id) SELECT $1, unnest($2::text[])', [id, fileIds]);
    await client.query('COMMIT');

    // Invalidate share cache
    await invalidateShareCache(id, userId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return id;
}

async function getShareLink(fileId, userId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.shareLink(fileId, userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query('SELECT id FROM share_links WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
  const shareId = res.rows[0]?.id || null;

  // Cache the result
  await setCache(cacheKey, shareId, DEFAULT_TTL);

  return shareId;
}

async function addFilesToShare(shareId, fileIds) {
  if (!fileIds || fileIds.length === 0) return;
  await pool.query(
    'INSERT INTO share_link_files(share_id, file_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
    [shareId, fileIds]
  );

  // Invalidate share cache when files are added
  await invalidateShareCache(shareId);
}

async function removeFilesFromShares(fileIds, userId) {
  if (!fileIds || fileIds.length === 0) return;
  await pool.query(
    `DELETE FROM share_link_files
     WHERE file_id = ANY($1::text[])
       AND share_id IN (SELECT id FROM share_links WHERE user_id = $2)`,
    [fileIds, userId]
  );
}

async function deleteShareLink(fileId, userId) {
  // Get share ID before deleting for cache invalidation
  const shareResult = await pool.query('SELECT id FROM share_links WHERE file_id = $1 AND user_id = $2', [
    fileId,
    userId,
  ]);
  const shareId = shareResult.rows[0]?.id;

  await pool.query('DELETE FROM share_links WHERE file_id = $1 AND user_id = $2', [fileId, userId]);

  // Invalidate share cache
  if (shareId) {
    await invalidateShareCache(shareId, userId);
  }
  await deleteCache(cacheKeys.shareLink(fileId, userId));
}

async function getFileByToken(token) {
  // Try to get from cache first
  const cacheKey = cacheKeys.shareByToken(token);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.path, f.user_id AS "userId"
     FROM share_links s
     JOIN files f ON s.file_id = f.id
     WHERE s.id = $1`,
    [token]
  );
  const file = res.rows[0] || null;

  // Cache the result
  if (file) {
    await setCache(cacheKey, file, DEFAULT_TTL);
  }

  return file;
}

async function getFolderContents(folderId, userId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.shareFolderContents(folderId, userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.size, f.path,
            sl.id AS token
     FROM files f
     LEFT JOIN share_links sl ON sl.file_id = f.id AND sl.user_id = $2
     WHERE f.parent_id = $1 AND f.user_id = $2 AND sl.id IS NOT NULL
     ORDER BY f.type DESC, f.name`,
    [folderId, userId]
  );
  const files = res.rows;

  // Cache the result (1 minute TTL)
  await setCache(cacheKey, files, 60);

  return files;
}

async function getFolderContentsByShare(token, folderId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.shareFolderContents(token, folderId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.size, f.path
     FROM share_link_files s
     JOIN files f ON s.file_id = f.id
     WHERE s.share_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'}
     ORDER BY f.type DESC, f.name`,
    folderId ? [token, folderId] : [token]
  );
  const files = res.rows;

  // Cache the result
  await setCache(cacheKey, files, 60); // 1 minute TTL

  return files;
}

async function isFileShared(token, fileId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.fileShared(token, fileId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query('SELECT 1 FROM share_link_files WHERE share_id = $1 AND file_id = $2', [token, fileId]);
  const isShared = res.rowCount > 0;

  // Cache the result (5 minutes TTL)
  await setCache(cacheKey, isShared, DEFAULT_TTL);

  return isShared;
}

async function getSharedTree(token, rootId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT f.* FROM files f
       JOIN share_link_files slf ON slf.file_id = f.id
       WHERE slf.share_id = $1 AND f.id = $2
       UNION ALL
       SELECT f.* FROM files f
       JOIN share_link_files slf ON slf.file_id = f.id
       JOIN sub s ON f.parent_id = s.id
       WHERE slf.share_id = $1
     )
     SELECT id, name, type, path, parent_id FROM sub`,
    [token, rootId]
  );
  return res.rows;
}

module.exports = {
  createShareLink,
  getShareLink,
  addFilesToShare,
  removeFilesFromShares,
  deleteShareLink,
  getFileByToken,
  getFolderContents,
  getFolderContentsByShare,
  isFileShared,
  getSharedTree,
};
