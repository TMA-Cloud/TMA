import Cursor from 'pg-cursor';

import pool from '../../config/db.js';
import { deleteCachePattern, invalidateAllFileCaches, cacheKeys, getCache, setCache } from '../../utils/cache.js';
import { buildKeysetPage, buildOrderClause, finishKeysetPage } from './file.utils.model.js';

/**
 * Set starred status for files
 */
async function setStarred(ids, starred, userId) {
  await pool.query('UPDATE files SET starred = $1 WHERE id = ANY($2::text[]) AND user_id = $3', [starred, ids, userId]);

  // Invalidate cache (starred status affects file listings and stats)
  await invalidateAllFileCaches(userId);
  // Invalidate starred files cache
  await deleteCachePattern(`files:${userId}:starred:*`);
}

/**
 * Get starred files
 */
async function getStarredFiles(userId, sortBy = 'modified', order = 'DESC', pageOptions = null) {
  const page = pageOptions ? buildKeysetPage(sortBy, order, pageOptions.cursor, 'f', 2, pageOptions.limit) : null;
  const baseCacheKey = cacheKeys.starredFiles(userId, sortBy, order);
  const cacheKey = page ? `${baseCacheKey}:page:${pageOptions.cursor || 'first'}:${page.limit}` : baseCacheKey;
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const orderClause = page?.orderClause || buildOrderClause(sortBy, order, 'f');
  const result = await pool.query(
    `SELECT f.id, f.name, f.type,
            CASE WHEN f.type = 'folder' THEN f.aggregate_size ELSE f.size END AS size,
            f.modified, f.accessed_at AS "accessedAt", f.shared_at AS "sharedAt", f.mime_type AS "mimeType", f.starred, f.shared,
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
     WHERE f.user_id = $1 AND f.starred = TRUE AND f.deleted_at IS NULL
     ${page?.whereClause || ''} ${orderClause}
     ${page ? `LIMIT ${page.limitParam}` : ''}`,
    [userId, ...(page?.params || [])]
  );
  const files = result.rows;
  const response = page ? finishKeysetPage(files, page) : files;
  await setCache(cacheKey, response, 60);

  return response;
}

/**
 * Set shared status for files (recursively)
 */
async function setShared(ids, shared, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return [];
  const res = await pool.query(
    `UPDATE files
     SET shared = $1,
         shared_at = CASE WHEN $1 THEN COALESCE(shared_at, NOW()) ELSE NULL END
     WHERE id = ANY($2::text[]) AND user_id = $3
     RETURNING id`,
    [shared, allIds, userId]
  );

  // Invalidate cache (shared status affects file listings and stats)
  await invalidateAllFileCaches(userId);
  // Invalidate shared files cache
  await deleteCachePattern(`files:${userId}:shared:*`);

  return res.rows.map(r => r.id);
}

/**
 * Get shared files (top-level only), including share link expiry info
 */
async function getSharedFiles(userId, sortBy = 'modified', order = 'DESC', pageOptions = null) {
  const page = pageOptions ? buildKeysetPage(sortBy, order, pageOptions.cursor, 'f', 2, pageOptions.limit) : null;
  const baseCacheKey = cacheKeys.sharedFiles(userId, sortBy, order);
  const cacheKey = page ? `${baseCacheKey}:page:${pageOptions.cursor || 'first'}:${page.limit}` : baseCacheKey;
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const orderClause = page?.orderClause || buildOrderClause(sortBy, order, 'f');
  const result = await pool.query(
    `SELECT f.id, f.name, f.type,
            CASE WHEN f.type = 'folder' THEN f.aggregate_size ELSE f.size END AS size,
            f.modified, f.accessed_at AS "accessedAt", f.mime_type AS "mimeType",
            f.starred, f.shared, f.shared_at AS "sharedAt",
            CASE WHEN share_info.has_perpetual THEN NULL ELSE share_info.expires_at END AS "expiresAt"
     FROM files f
     LEFT JOIN files parent ON f.parent_id = parent.id AND parent.user_id = $1
     LEFT JOIN LATERAL (
       SELECT BOOL_OR(sl.expires_at IS NULL) AS has_perpetual,
              MAX(sl.expires_at) AS expires_at
         FROM share_link_files slf
         JOIN share_links sl ON sl.id = slf.share_id
        WHERE slf.file_id = f.id AND sl.user_id = $1
     ) share_info ON TRUE
     WHERE f.user_id = $1 
       AND f.shared = TRUE 
       AND f.deleted_at IS NULL
       AND (f.parent_id IS NULL OR parent.shared = FALSE OR parent.shared IS NULL)
     ${page?.whereClause || ''}
     ${orderClause}
     ${page ? `LIMIT ${page.limitParam}` : ''}`,
    [userId, ...(page?.params || [])]
  );
  const files = result.rows;
  const response = page ? finishKeysetPage(files, page) : files;
  await setCache(cacheKey, response, 60);

  return response;
}

/**
 * Get all recursive IDs for files (including children)
 */
async function getRecursiveIds(ids, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub(id, visited) AS (
       SELECT id, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2
       UNION ALL
       SELECT f.id, s.visited || f.id FROM files f JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND NOT f.id = ANY(s.visited)
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
    `WITH RECURSIVE sub(id, name, type, path, size, parent_id, visited) AS (
       SELECT id, name, type, path, size, parent_id, ARRAY[id] FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT f.id, f.name, f.type, f.path, f.size, f.parent_id, s.visited || f.id FROM files f
       JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND f.deleted_at IS NULL AND NOT f.id = ANY(s.visited)
     )
     SELECT id, name, type, path, size, parent_id FROM sub`,
    [folderId, userId]
  );
  return res.rows;
}

/** Aggregate folder info in PostgreSQL so the API retains only one row. */
async function getFolderTreeStats(folderId, userId) {
  const result = await pool.query(
    `SELECT aggregate_size AS total_size,
            aggregate_file_count AS file_count,
            aggregate_folder_count AS folder_count
       FROM files
      WHERE id = $1 AND user_id = $2 AND type = 'folder' AND deleted_at IS NULL`,
    [folderId, userId]
  );
  const row = result.rows[0];
  if (!row) return { totalSize: 0, fileCount: 0, folderCount: 0 };
  return {
    totalSize: Number(row.total_size) || 0,
    fileCount: row.file_count,
    folderCount: row.folder_count,
  };
}

/** Stream archive entries with their final ZIP path; holds only one DB page. */
async function* streamArchiveEntries(rootIds, userId, batchSize = 200) {
  if (!Array.isArray(rootIds) || rootIds.length === 0) return;
  const client = await pool.connect();
  const cursor = client.query(
    new Cursor(
      `WITH RECURSIVE tree(id, name, type, path, parent_id, archive_path, visited) AS (
         SELECT f.id, f.name, f.type, f.path, f.parent_id, f.name::text, ARRAY[f.id]
           FROM files f
          WHERE f.id = ANY($1::text[]) AND f.user_id = $2 AND f.deleted_at IS NULL
         UNION ALL
         SELECT f.id, f.name, f.type, f.path, f.parent_id,
                tree.archive_path || '/' || f.name, tree.visited || f.id
           FROM files f
           JOIN tree ON f.parent_id = tree.id
          WHERE f.user_id = $2 AND f.deleted_at IS NULL AND NOT f.id = ANY(tree.visited)
       )
       SELECT id, name, type, path, parent_id, archive_path AS "archivePath"
         FROM tree
        ORDER BY archive_path, id`,
      [rootIds, userId]
    )
  );
  try {
    for (;;) {
      const rows = await cursor.read(batchSize);
      if (rows.length === 0) break;
      for (const row of rows) yield row;
    }
  } finally {
    await cursor.close().catch(() => {});
    client.release();
  }
}

export {
  setStarred,
  getStarredFiles,
  setShared,
  getSharedFiles,
  getRecursiveIds,
  getFolderTree,
  getFolderTreeStats,
  streamArchiveEntries,
};
