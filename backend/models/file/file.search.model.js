import pool from '../../config/db.js';
import { getCache, setCache, cacheKeys, DEFAULT_TTL } from '../../utils/cache.js';
import { fillFolderSizes } from './file.utils.model.js';

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
        accessed_at AS "accessedAt",
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
        accessed_at AS "accessedAt",
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
  const cacheKey = cacheKeys.fileStats(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

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

/**
 * How many rows the cached recent list holds.
 */
const RECENT_CACHE_SIZE = 50;

/**
 * Recently opened files, most recent first.
 *
 * The query is a plain top-N against idx_files_user_accessed_at
 * (user_id, accessed_at DESC) WHERE deleted_at IS NULL as the index's leading
 * column, its order, and its predicate all match the query, Postgres walks the
 * index backwards and stops once LIMIT rows are in hand.
 *
 * `type = 'file'` is intentionally *not* in that index. Adding it would make
 * the scan exact, at the price of a second index to maintain on every
 * accessed_at write and the write path here is the whole reason the column is
 * cheap. Filtering after the index scan instead costs only the folder entries
 * skipped along the way.
 *
 * @param {string} userId - Account owner
 * @param {number} limit - Rows to return, capped at RECENT_CACHE_SIZE
 * @returns {Promise<Array>} Files ordered by accessed_at DESC
 */
async function getRecentFiles(userId, limit = 10) {
  const wanted = Math.min(Math.max(Number(limit) || 0, 1), RECENT_CACHE_SIZE);

  const cacheKey = cacheKeys.recentFiles(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached.slice(0, wanted);
  }

  const result = await pool.query(
    `SELECT id, name, type, size, modified, accessed_at AS "accessedAt",
            mime_type AS "mimeType", starred, shared
       FROM files
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND type = 'file'
      ORDER BY accessed_at DESC
      LIMIT $2`,
    [userId, RECENT_CACHE_SIZE]
  );

  await setCache(cacheKey, result.rows, DEFAULT_TTL);

  return result.rows.slice(0, wanted);
}

export { searchFiles, getFileStats, getRecentFiles, RECENT_CACHE_SIZE };
