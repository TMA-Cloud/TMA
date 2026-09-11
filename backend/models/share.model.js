import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import Cursor from 'pg-cursor';

import { generateId } from '../utils/id.js';
import {
  getCache,
  getCaches,
  setCache,
  setCaches,
  deleteCache,
  deleteCaches,
  cacheKeys,
  invalidateShareCache,
  invalidateFileCache,
  invalidateAllFileCaches,
  DEFAULT_TTL,
} from '../utils/cache.js';

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

/** Create/update every selected root and populate all memberships in one recursive statement. */
async function upsertShareRoots(rootIds, userId, expiresAt) {
  if (!Array.isArray(rootIds) || rootIds.length === 0) return { tokens: {}, counts: {}, created: [] };
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    // Serializes share creation for this account because the historical schema
    // permits more than one link per (user, root).
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const existing = await client.query(
      `SELECT DISTINCT ON (file_id) file_id, id
         FROM share_links
        WHERE user_id = $1 AND file_id = ANY($2::text[])
        ORDER BY file_id, created_at, id`,
      [userId, rootIds]
    );
    const tokens = Object.fromEntries(existing.rows.map(row => [row.file_id, row.id]));
    const created = [];
    for (const rootId of rootIds) {
      if (!tokens[rootId]) {
        tokens[rootId] = generateId(16);
        created.push(rootId);
      }
    }
    const shareIds = rootIds.map(rootId => tokens[rootId]);
    result = await client.query(
      `WITH RECURSIVE mapping(root_id, share_id) AS (
         SELECT * FROM unnest($1::text[], $2::text[])
       ), inserted_links AS (
         INSERT INTO share_links(id, file_id, user_id, expires_at)
         SELECT m.share_id, m.root_id, $3, $4
           FROM mapping m
          WHERE NOT EXISTS (SELECT 1 FROM share_links sl WHERE sl.id = m.share_id)
         RETURNING id
       ), updated_links AS (
         UPDATE share_links sl SET expires_at = $4
          FROM mapping m WHERE sl.id = m.share_id
         RETURNING sl.id
       ), tree(root_id, id, visited) AS (
         SELECT f.id, f.id, ARRAY[f.id]
           FROM files f WHERE f.id = ANY($1::text[]) AND f.user_id = $3 AND f.deleted_at IS NULL
         UNION ALL
         SELECT tree.root_id, child.id, tree.visited || child.id
           FROM files child JOIN tree ON child.parent_id = tree.id
          WHERE child.user_id = $3 AND child.deleted_at IS NULL AND NOT child.id = ANY(tree.visited)
       ), updated_files AS (
         UPDATE files f
            SET shared = TRUE, shared_at = COALESCE(shared_at, NOW())
           FROM tree WHERE f.id = tree.id AND f.user_id = $3
         RETURNING f.id
       ), linked AS (
         INSERT INTO share_link_files(share_id, file_id)
         SELECT m.share_id, tree.id FROM tree JOIN mapping m ON m.root_id = tree.root_id
         ON CONFLICT DO NOTHING
         RETURNING share_id
       )
       SELECT m.root_id, m.share_id, COUNT(tree.id)::integer AS file_count
         FROM mapping m LEFT JOIN tree ON tree.root_id = m.root_id
        GROUP BY m.root_id, m.share_id`,
      [rootIds, shareIds, userId, expiresAt]
    );
    await client.query('COMMIT');
    await Promise.all([
      ...shareIds.map(shareId => invalidateShareCache(shareId, userId)),
      ...rootIds.map(rootId => deleteCache(cacheKeys.shareLink(rootId, userId))),
    ]);
    return {
      tokens,
      counts: Object.fromEntries(result.rows.map(row => [row.root_id, row.file_count])),
      created,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getShareLink(fileId, userId) {
  const cacheKey = cacheKeys.shareLink(fileId, userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

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
  const cachedValues = await getCaches(fileIds.map(fileId => cacheKeys.shareLink(fileId, userId)));
  const cacheResults = {};
  const uncachedIds = [];

  for (let index = 0; index < fileIds.length; index += 1) {
    const fileId = fileIds[index];
    const cached = cachedValues[index];
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
  const cacheEntries = uncachedIds.map(fileId => {
    const shareId = dbResults[fileId] || null;
    dbResults[fileId] = shareId;
    return [cacheKeys.shareLink(fileId, userId), shareId];
  });
  await setCaches(cacheEntries, DEFAULT_TTL);

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

/** Remove selected trees from shares without returning every descendant to Node. */
async function unshareRoots(rootIds, userId) {
  if (!Array.isArray(rootIds) || rootIds.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE unshare_stage ON COMMIT DROP AS
       WITH RECURSIVE tree(id, visited) AS (
         SELECT id, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2
         UNION ALL
         SELECT child.id, tree.visited || child.id
           FROM files child JOIN tree ON child.parent_id = tree.id
          WHERE child.user_id = $2 AND NOT child.id = ANY(tree.visited)
       ) SELECT DISTINCT id FROM tree`,
      [rootIds, userId]
    );
    const affectedShares = await client.query(
      `SELECT DISTINCT slf.share_id
         FROM share_link_files slf JOIN share_links sl ON sl.id = slf.share_id
        WHERE sl.user_id = $1 AND slf.file_id IN (SELECT id FROM unshare_stage)`,
      [userId]
    );
    await client.query(
      `DELETE FROM share_link_files slf
        USING share_links sl
        WHERE slf.share_id = sl.id AND sl.user_id = $1
          AND slf.file_id IN (SELECT id FROM unshare_stage)`,
      [userId]
    );
    await client.query('DELETE FROM share_links WHERE user_id = $1 AND file_id = ANY($2::text[])', [userId, rootIds]);
    const updated = await client.query(
      `UPDATE files f
          SET shared = EXISTS (SELECT 1 FROM share_link_files slf WHERE slf.file_id = f.id),
              shared_at = CASE
                WHEN EXISTS (SELECT 1 FROM share_link_files slf WHERE slf.file_id = f.id)
                THEN COALESCE(f.shared_at, NOW()) ELSE NULL END
        WHERE f.user_id = $1 AND f.id IN (SELECT id FROM unshare_stage)
        RETURNING f.id`,
      [userId]
    );
    await client.query('COMMIT');
    await Promise.all(affectedShares.rows.map(row => invalidateShareCache(row.share_id, userId)));
    await deleteCaches(rootIds.map(id => cacheKeys.shareLink(id, userId)));
    await invalidateAllFileCaches(userId);
    return updated.rowCount || 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Link selected trees to every share containing their direct parent. */
async function linkItemsToParentShares(rootIds, userId) {
  if (!Array.isArray(rootIds) || rootIds.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE link_stage ON COMMIT DROP AS
       WITH RECURSIVE roots(root_id, id, parent_id, visited) AS (
         SELECT f.id, f.id, f.parent_id, ARRAY[f.id]
           FROM files f WHERE f.id = ANY($1::text[]) AND f.user_id = $2 AND f.deleted_at IS NULL
         UNION ALL
         SELECT roots.root_id, child.id, child.parent_id, roots.visited || child.id
           FROM files child JOIN roots ON child.parent_id = roots.id
          WHERE child.user_id = $2 AND child.deleted_at IS NULL AND NOT child.id = ANY(roots.visited)
       ), parent_shares AS (
         SELECT root.id AS root_id, slf.share_id
           FROM files root
           JOIN share_link_files slf ON slf.file_id = root.parent_id
           JOIN share_links sl ON sl.id = slf.share_id AND sl.user_id = $2
          WHERE root.id = ANY($1::text[]) AND root.user_id = $2
       )
       SELECT DISTINCT roots.root_id, roots.id AS file_id, parent_shares.share_id
         FROM roots JOIN parent_shares ON parent_shares.root_id = roots.root_id`,
      [rootIds, userId]
    );
    await client.query(
      `INSERT INTO share_link_files(share_id, file_id)
       SELECT share_id, file_id FROM link_stage ON CONFLICT DO NOTHING`
    );
    await client.query(
      `UPDATE files f SET shared = TRUE, shared_at = COALESCE(shared_at, NOW())
        WHERE f.user_id = $1 AND f.id IN (SELECT file_id FROM link_stage)`,
      [userId]
    );
    const mappings = await client.query('SELECT DISTINCT root_id, share_id FROM link_stage ORDER BY root_id, share_id');
    await client.query('COMMIT');
    const shareIds = [...new Set(mappings.rows.map(row => row.share_id))];
    await Promise.all(shareIds.map(shareId => invalidateShareCache(shareId, userId)));
    await invalidateAllFileCaches(userId);
    return mappings.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  await deleteCaches(fileIds.map(fileId => cacheKeys.shareLink(fileId, userId)));
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
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.size, f.path, f.user_id AS "userId",
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

function decodeShareCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(value.rank) && typeof value.name === 'string' && typeof value.id === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

async function getFolderContentsByShare(token, folderId, { cursor = null, limit = 100 } = {}) {
  const pageLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  const decoded = decodeShareCursor(cursor);
  const cacheKey = `${cacheKeys.shareFolderContents(token, folderId)}:page:${cursor || 'first'}:${pageLimit}`;
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.size, f.path,
            CASE WHEN f.type = 'folder' THEN 0 ELSE 1 END AS sort_rank
     FROM share_link_files s
     JOIN files f ON s.file_id = f.id
     WHERE s.share_id = $1 AND f.parent_id = $2 AND f.deleted_at IS NULL
       AND ($3::integer IS NULL OR
            (CASE WHEN f.type = 'folder' THEN 0 ELSE 1 END, LOWER(f.name), f.id) > ($3, $4, $5))
     ORDER BY sort_rank, LOWER(f.name), f.id
     LIMIT $6`,
    [token, folderId, decoded?.rank ?? null, decoded?.name ?? null, decoded?.id ?? null, pageLimit + 1]
  );
  const hasMore = res.rows.length > pageLimit;
  const files = res.rows.slice(0, pageLimit).map(({ sort_rank: _rank, ...file }) => file);
  const last = res.rows[Math.min(res.rows.length, pageLimit) - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({ rank: last.sort_rank, name: last.name.toLocaleLowerCase(), id: last.id })
        ).toString('base64url')
      : null;
  const page = { items: files, nextCursor };

  // Cache the result
  await setCache(cacheKey, page, 60); // 1 minute TTL

  return page;
}

/**
 * Ancestor chain for a folder within a share, from the shared root down to the
 * folder itself. Walks up via parent_id but only through rows that belong to
 * this share, so the walk naturally stops at the shared root and never leaks
 * folders outside the link. Returns [] when the folder is not a shared folder.
 */
async function getSharedFolderPath(token, folderId) {
  const res = await pool.query(
    `WITH RECURSIVE up(id, name, type, parent_id, visited) AS (
       SELECT f.id, f.name, f.type, f.parent_id, ARRAY[f.id]
       FROM files f
       JOIN share_link_files slf ON slf.file_id = f.id
       WHERE slf.share_id = $1 AND f.id = $2
       UNION ALL
       SELECT f.id, f.name, f.type, f.parent_id, up.visited || f.id
       FROM files f
       JOIN share_link_files slf ON slf.file_id = f.id
       JOIN up ON up.parent_id = f.id
       WHERE slf.share_id = $1 AND NOT f.id = ANY(up.visited)
     )
     SELECT id, name, type FROM up`,
    [token, folderId]
  );
  // CTE yields leaf → root; callers want root → leaf.
  return res.rows.reverse();
}

/**
 * Share ids whose subtree contains this folder — i.e. shares the folder is a
 * member of, whether it is the shared root or a nested subfolder. Used to link
 * newly added items into the same share(s) as their parent folder.
 */
async function getShareIdsContainingFolder(folderId, userId) {
  if (!folderId) return [];
  const res = await pool.query(
    `SELECT DISTINCT slf.share_id
     FROM share_link_files slf
     JOIN share_links sl ON sl.id = slf.share_id
     WHERE slf.file_id = $1 AND sl.user_id = $2`,
    [folderId, userId]
  );
  return res.rows.map(r => r.share_id);
}

async function isFileShared(token, fileId) {
  const cacheKey = cacheKeys.fileShared(token, fileId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const res = await pool.query('SELECT 1 FROM share_link_files WHERE share_id = $1 AND file_id = $2', [token, fileId]);
  const isShared = res.rowCount > 0;

  await setCache(cacheKey, isShared, DEFAULT_TTL);

  return isShared;
}

/** Stream a shared subtree with bounded memory and precomputed ZIP paths. */
async function* streamSharedArchiveEntries(token, rootId, batchSize = 200) {
  const client = await pool.connect();
  const cursor = client.query(
    new Cursor(
      `WITH RECURSIVE tree(id, name, type, path, parent_id, archive_path, visited) AS (
         SELECT f.id, f.name, f.type, f.path, f.parent_id, f.name::text, ARRAY[f.id]
           FROM files f
           JOIN share_link_files slf ON slf.file_id = f.id AND slf.share_id = $1
          WHERE f.id = $2 AND f.deleted_at IS NULL
         UNION ALL
         SELECT f.id, f.name, f.type, f.path, f.parent_id,
                tree.archive_path || '/' || f.name, tree.visited || f.id
           FROM files f
           JOIN share_link_files slf ON slf.file_id = f.id AND slf.share_id = $1
           JOIN tree ON f.parent_id = tree.id
          WHERE f.deleted_at IS NULL AND NOT f.id = ANY(tree.visited)
       )
       SELECT id, name, type, path, parent_id, archive_path AS "archivePath"
         FROM tree
        ORDER BY archive_path, id`,
      [token, rootId]
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

/**
 * Delete all expired share links and unshare associated files.
 * Intended to be run periodically (e.g. every 7 days).
 */
async function cleanupExpiredShareLinks({ batchSize = 500, maxBatches = 100 } = {}) {
  const client = await pool.connect();
  let totalCleaned = 0;
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      await client.query('BEGIN');
      const expired = await client.query(
        `SELECT s.id, s.file_id, s.user_id
           FROM share_links s
          WHERE s.expires_at IS NOT NULL AND s.expires_at < NOW()
          ORDER BY s.expires_at, s.id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );

      if (expired.rows.length === 0) {
        await client.query('COMMIT');
        break;
      }

      const shareIds = expired.rows.map(row => row.id);
      const userIds = expired.rows.map(row => row.user_id);
      const fileIds = expired.rows.map(row => row.file_id);

      // share_link_files is removed by ON DELETE CASCADE.
      await client.query('DELETE FROM share_links WHERE id = ANY($1::text[])', [shareIds]);
      await client.query(
        `WITH affected(user_id, file_id) AS (
           SELECT * FROM unnest($1::text[], $2::text[])
         )
         UPDATE files f SET shared = FALSE, shared_at = NULL
          FROM affected a
         WHERE f.id = a.file_id AND f.user_id = a.user_id
           AND NOT EXISTS (
             SELECT 1 FROM share_links sl WHERE sl.file_id = f.id AND sl.user_id = f.user_id
           )`,
        [userIds, fileIds]
      );
      await client.query('COMMIT');
      totalCleaned += shareIds.length;

      // External cache I/O happens only after releasing database row locks.
      const affectedUsers = [...new Set(userIds)];
      await Promise.all([
        ...affectedUsers.map(userId => invalidateFileCache(userId)),
        ...shareIds.map(shareId => invalidateShareCache(shareId)),
      ]);

      if (expired.rows.length < batchSize) break;
    }
    logger.info({ count: totalCleaned }, '[ShareCleanup] Cleaned up expired share links');
    return totalCleaned;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export {
  createShareLink,
  upsertShareRoots,
  getShareLink,
  getShareLinks,
  updateShareExpiry,
  addFilesToShare,
  removeFilesFromShares,
  unshareRoots,
  linkItemsToParentShares,
  deleteShareLink,
  deleteShareLinks,
  getFileByToken,
  getFolderContentsByShare,
  getSharedFolderPath,
  getShareIdsContainingFolder,
  isFileShared,
  streamSharedArchiveEntries,
  cleanupExpiredShareLinks,
};
