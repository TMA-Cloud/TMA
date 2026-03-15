import path from 'path';

import pool from '../../config/db.js';
import { getCache, setCache, cacheKeys, DEFAULT_TTL } from '../../utils/cache.js';

const SORT_FIELDS = {
  name: 'name',
  size: 'size',
  modified: 'modified',
  deletedAt: 'deleted_at',
};

/**
 * Build SQL ORDER BY clause for file sorting
 */
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

/**
 * Calculate folder size recursively
 */
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
  // PostgreSQL BIGINT can be returned as string for very large numbers
  // Convert to number if it's a valid number string, otherwise default to 0
  const sizeValue = res.rows[0].size;
  const size = typeof sizeValue === 'string' ? Number(sizeValue) || 0 : sizeValue || 0;

  // Cache the result (5 minutes TTL - folder sizes change less frequently)
  await setCache(cacheKey, size, DEFAULT_TTL);

  return size;
}

/**
 * Fill folder sizes for all folders in the files array
 */
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

function generateUniqueName(baseName, ext, counter) {
  return `${baseName} (${counter})${ext}`;
}

/**
 * Generates a unique filename in the database if a file with the same name
 * already exists in the target parent folder for the given user.
 * @param {string} desiredName - The desired file name.
 * @param {string} parentId - The parent folder ID.
 * @param {string} userId - The user ID.
 * @returns {Promise<string>} A unique file name.
 */
async function getUniqueDbFileName(desiredName, parentId, userId) {
  const ext = path.extname(desiredName);
  const baseName = path.basename(desiredName, ext);

  let uniqueName = desiredName;
  let counter = 1;

  while (true) {
    const res = await pool.query(
      'SELECT id FROM files WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2 AND user_id = $3 AND type = $4 AND deleted_at IS NULL',
      [uniqueName, parentId, userId, 'file']
    );

    if (res.rows.length === 0) {
      break; // Name is unique
    }

    uniqueName = generateUniqueName(baseName, ext, counter);
    counter++;

    if (counter > 10000) {
      throw new Error('Too many duplicate names in database');
    }
  }
  return uniqueName;
}

export { SORT_FIELDS, buildOrderClause, calculateFolderSize, fillFolderSizes, generateUniqueName, getUniqueDbFileName };
