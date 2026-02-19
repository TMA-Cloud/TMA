const pool = require('../config/db');
const { generateId } = require('../utils/id');
const {
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  cacheKeys,
  invalidateShareCache,
  invalidateFileCache,
  DEFAULT_TTL,
} = require('../utils/cache');
const { logger } = require('../config/logger');

async function createShareLink(fileId, userId, fileIds = [fileId], expiresAt = null) {
  const id = generateId(16);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO share_links(id, file_id, user_id, expires_at) VALUES($1,$2,$3,$4)', [
      id,
      fileId,
      userId,
      expiresAt,
    ]);
    await client.query('INSERT INTO share_link_files(share_id, file_id) SELECT $1, unnest($2::text[])', [id, fileIds]);
    await client.query('COMMIT');

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

/**
 * Get share links for multiple files (bulk operation)
 * Returns a map: { fileId: shareId | null }
 */
async function getShareLinks(fileIds, userId) {
  if (!fileIds || fileIds.length === 0) return {};

  // Try to get from cache first for all files (parallel)
  const cachePromises = fileIds.map(async fileId => {
    const cacheKey = cacheKeys.shareLink(fileId, userId);
    const cached = await getCache(cacheKey);
    return { fileId, cached };
  });

  const cacheResultsArray = await Promise.all(cachePromises);
  const cacheResults = {};
  const uncachedIds = [];

  for (const { fileId, cached } of cacheResultsArray) {
    if (cached !== null) {
      cacheResults[fileId] = cached;
    } else {
      uncachedIds.push(fileId);
    }
  }

  // If all were cached, return immediately
  if (uncachedIds.length === 0) {
    return cacheResults;
  }

  // Query database for uncached items
  const res = await pool.query('SELECT file_id, id FROM share_links WHERE file_id = ANY($1::text[]) AND user_id = $2', [
    uncachedIds,
    userId,
  ]);

  // Build result map from database results
  const dbResults = {};
  for (const row of res.rows) {
    dbResults[row.file_id] = row.id;
  }

  // Cache all results (including nulls for files without share links) in parallel
  const cacheSetPromises = uncachedIds.map(async fileId => {
    const shareId = dbResults[fileId] || null;
    const cacheKey = cacheKeys.shareLink(fileId, userId);
    await setCache(cacheKey, shareId, DEFAULT_TTL);
    dbResults[fileId] = shareId;
  });
  await Promise.all(cacheSetPromises);

  // Merge cached and database results
  return { ...cacheResults, ...dbResults };
}

async function updateShareExpiry(shareId, expiresAt) {
  await pool.query('UPDATE share_links SET expires_at = $1 WHERE id = $2', [expiresAt, shareId]);
  await invalidateShareCache(shareId);
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

/**
 * Delete share links for multiple files (bulk operation)
 */
async function deleteShareLinks(fileIds, userId) {
  if (!fileIds || fileIds.length === 0) return;

  // Get share IDs before deleting for cache invalidation
  const shareResult = await pool.query(
    'SELECT id, file_id FROM share_links WHERE file_id = ANY($1::text[]) AND user_id = $2',
    [fileIds, userId]
  );

  const shareIds = shareResult.rows.map(r => r.id);
  const fileIdToShareId = {};
  for (const row of shareResult.rows) {
    fileIdToShareId[row.file_id] = row.id;
  }

  // Delete all share links in one query
  await pool.query('DELETE FROM share_links WHERE file_id = ANY($1::text[]) AND user_id = $2', [fileIds, userId]);

  // Invalidate share cache for all affected shares
  for (const shareId of shareIds) {
    await invalidateShareCache(shareId, userId);
  }

  // Delete cache for all files
  for (const fileId of fileIds) {
    await deleteCache(cacheKeys.shareLink(fileId, userId));
  }
}

/**
 * Look up a share link by token.
 * Returns:
 *   file object  — valid link
 *   { expired: true } — link exists but is past its expires_at
 *   null — token does not exist
 */
async function getFileByToken(token) {
  const cacheKey = cacheKeys.shareByToken(token);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    if (cached.expiresAt && new Date(cached.expiresAt) < new Date()) {
      await deleteCache(cacheKey);
      return { expired: true };
    }
    return cached;
  }

  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.path, f.user_id AS "userId",
            s.expires_at AS "expiresAt"
     FROM share_links s
     JOIN files f ON s.file_id = f.id
     WHERE s.id = $1`,
    [token]
  );
  const file = res.rows[0] || null;

  if (file) {
    if (file.expiresAt && new Date(file.expiresAt) < new Date()) {
      return { expired: true };
    }
    // Cache TTL = min(DEFAULT_TTL, seconds until expiry) so the entry
    // can never outlive the link's expiration.
    let ttl = DEFAULT_TTL;
    if (file.expiresAt) {
      const remaining = Math.floor((new Date(file.expiresAt) - Date.now()) / 1000);
      ttl = Math.min(ttl, Math.max(remaining, 1));
    }
    await setCache(cacheKey, file, ttl);
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

/**
 * Delete all expired share links and unshare associated files.
 * Intended to be run periodically (e.g. every 7 days).
 */
async function cleanupExpiredShareLinks() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const expired = await client.query(
      `SELECT s.id, s.file_id, s.user_id
       FROM share_links s
       WHERE s.expires_at IS NOT NULL AND s.expires_at < NOW()`
    );

    if (expired.rows.length === 0) {
      await client.query('COMMIT');
      logger.info('[ShareCleanup] No expired share links found');
      return;
    }

    const shareIds = expired.rows.map(r => r.id);

    await client.query('DELETE FROM share_link_files WHERE share_id = ANY($1::text[])', [shareIds]);
    await client.query('DELETE FROM share_links WHERE id = ANY($1::text[])', [shareIds]);

    const userFileMap = new Map();
    for (const row of expired.rows) {
      if (!userFileMap.has(row.user_id)) {
        userFileMap.set(row.user_id, []);
      }
      userFileMap.get(row.user_id).push(row.file_id);
    }

    for (const [userId, fileIds] of userFileMap) {
      await client.query(
        `UPDATE files SET shared = FALSE
         WHERE id = ANY($1::text[]) AND user_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM share_links sl WHERE sl.file_id = files.id AND sl.user_id = $2
           )`,
        [fileIds, userId]
      );
      await invalidateFileCache(userId);
      await deleteCachePattern(`files:${userId}:shared:*`);
    }

    for (const shareId of shareIds) {
      await invalidateShareCache(shareId);
    }

    await client.query('COMMIT');
    logger.info({ count: shareIds.length }, '[ShareCleanup] Cleaned up expired share links');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createShareLink,
  getShareLink,
  getShareLinks,
  updateShareExpiry,
  addFilesToShare,
  removeFilesFromShares,
  deleteShareLink,
  deleteShareLinks,
  getFileByToken,
  getFolderContents,
  getFolderContentsByShare,
  isFileShared,
  getSharedTree,
  cleanupExpiredShareLinks,
};
