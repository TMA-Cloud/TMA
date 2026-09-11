import path from 'path';

import pool from '../../config/db.js';
import { getCache, getCaches, setCache, setCaches, cacheKeys, DEFAULT_TTL } from '../../utils/cache.js';

const SORT_FIELDS = {
  name: 'name',
  size: 'size',
  modified: 'modified',
  accessedAt: 'accessed_at',
  deletedAt: 'deleted_at',
};

const CURSOR_FIELDS = {
  name: { sql: 'name', property: 'name' },
  size: {
    property: 'size',
    expression: tableAlias =>
      `(CASE WHEN ${tableAlias}.type = 'folder' THEN ${tableAlias}.aggregate_size ELSE ${tableAlias}.size END)`,
  },
  modified: { sql: 'modified', property: 'modified' },
  accessedAt: { sql: 'accessed_at', property: 'accessedAt' },
  deletedAt: { sql: 'deleted_at', property: 'deletedAt' },
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
  const qualifiedField =
    field === 'size'
      ? `(CASE WHEN ${tableAlias || 'files'}.type = 'folder' THEN ${tableAlias || 'files'}.aggregate_size ELSE ${tableAlias || 'files'}.size END)`
      : tableAlias
        ? `${tableAlias}.${field}`
        : field;
  return `ORDER BY ${qualifiedField} ${dir}${nulls}`;
}

function decodePageCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.type !== 'string' || typeof parsed.id !== 'string' || parsed.value == null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Build stable folder-first keyset pagination for non-null sortable columns. */
function buildKeysetPage(sortBy, order, cursor, tableAlias = 'f', firstParameter = 1, requestedLimit = 200) {
  const field = CURSOR_FIELDS[sortBy];
  if (!field) return null;
  const direction = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const compare = direction === 'ASC' ? '>' : '<';
  let decoded = decodePageCursor(cursor);
  if (decoded) {
    const valueIsValid =
      field.property === 'name'
        ? typeof decoded.value === 'string'
        : typeof decoded.value === 'string' && Number.isFinite(Date.parse(decoded.value));
    if (!valueIsValid || !['file', 'folder'].includes(decoded.type)) decoded = null;
  }
  const limit = Math.min(Math.max(Number(requestedLimit) || 200, 1), 500);
  const qualifiedField = field.expression ? field.expression(tableAlias) : `${tableAlias}.${field.sql}`;
  const orderClause = `ORDER BY ${tableAlias}.type DESC, ${qualifiedField} ${direction}, ${tableAlias}.id ${direction}`;
  if (!decoded) {
    return {
      whereClause: '',
      orderClause,
      params: [limit + 1],
      limit,
      property: field.property,
      limitParam: `$${firstParameter}`,
    };
  }
  const typeParam = `$${firstParameter}`;
  const valueParam = `$${firstParameter + 1}`;
  const idParam = `$${firstParameter + 2}`;
  const limitParam = `$${firstParameter + 3}`;
  return {
    whereClause: `AND (
      ${tableAlias}.type < ${typeParam}
      OR (${tableAlias}.type = ${typeParam} AND (
        ${qualifiedField} ${compare} ${valueParam}
        OR (${qualifiedField} = ${valueParam} AND ${tableAlias}.id ${compare} ${idParam})
      ))
    )`,
    orderClause,
    params: [decoded.type, decoded.value, decoded.id, limit + 1],
    limit,
    property: field.property,
    limitParam,
  };
}

function finishKeysetPage(rows, page) {
  const hasMore = rows.length > page.limit;
  const files = hasMore ? rows.slice(0, page.limit) : rows;
  const last = files.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ type: last.type, value: last[page.property], id: last.id })).toString('base64url')
      : null;
  return { files, nextCursor };
}

/**
 * Calculate folder size recursively
 */
async function calculateFolderSize(id, userId) {
  const cacheKey = cacheKeys.folderSize(id, userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, size, type, ARRAY[id]::text[] AS ancestors
         FROM files WHERE id = $1 AND user_id = $2
       UNION ALL
       SELECT f.id, f.size, f.type, s.ancestors || f.id
         FROM files f
         JOIN sub s ON f.parent_id = s.id
        WHERE f.user_id = $2 AND NOT f.id = ANY(s.ancestors)
     )
     SELECT COALESCE(SUM(size), 0) AS size FROM sub WHERE type = 'file'`,
    [id, userId]
  );
  // PostgreSQL BIGINT can be returned as string for very large numbers
  // Convert to number if it's a valid number string, otherwise default to 0
  const sizeValue = res.rows[0].size;
  const size = typeof sizeValue === 'string' ? Number(sizeValue) || 0 : sizeValue || 0;

  await setCache(cacheKey, size, DEFAULT_TTL);

  return size;
}

/**
 * Fill folder sizes for all folders in the files array
 */
async function fillFolderSizes(files, userId) {
  const folders = files.filter(file => file.type === 'folder');
  if (folders.length === 0) return files;

  // One recursive walk for the whole result set.  The previous implementation
  // issued one recursive query per folder (an N+1 query pattern).
  const folderIds = [...new Set(folders.map(folder => folder.id))];
  const cacheKeyById = new Map(folderIds.map(id => [id, cacheKeys.folderSize(id, userId)]));
  const cachedValues = await getCaches(folderIds.map(id => cacheKeyById.get(id)));
  const cachedSizes = new Map();
  const missingIds = [];
  folderIds.forEach((id, index) => {
    if (cachedValues[index] === null) missingIds.push(id);
    else cachedSizes.set(id, Number(cachedValues[index]) || 0);
  });
  if (missingIds.length === 0) {
    for (const folder of folders) folder.size = cachedSizes.get(folder.id) || 0;
    return files;
  }
  const result = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT f.id AS root_id, f.id, f.size, f.type, ARRAY[f.id]::text[] AS ancestors
         FROM files f
        WHERE f.id = ANY($1::text[]) AND f.user_id = $2
       UNION ALL
       SELECT s.root_id, f.id, f.size, f.type, s.ancestors || f.id
         FROM files f
         JOIN sub s ON f.parent_id = s.id
        WHERE f.user_id = $2 AND NOT f.id = ANY(s.ancestors)
     )
     SELECT root_id, COALESCE(SUM(size) FILTER (WHERE type = 'file'), 0) AS size
       FROM sub
      GROUP BY root_id`,
    [missingIds, userId]
  );
  const sizes = new Map([...cachedSizes, ...result.rows.map(row => [row.root_id, Number(row.size) || 0])]);
  for (const folder of folders) folder.size = sizes.get(folder.id) || 0;
  await setCaches(
    missingIds.map(id => [cacheKeyById.get(id), sizes.get(id) || 0]),
    DEFAULT_TTL
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
async function getUniqueDbFileName(desiredName, parentId, userId, queryable = pool) {
  const ext = path.extname(desiredName);
  const baseName = path.basename(desiredName, ext);

  const res = await queryable.query(
    `SELECT name FROM files
      WHERE parent_id IS NOT DISTINCT FROM $1
        AND user_id = $2 AND type = 'file' AND deleted_at IS NULL
        AND (name = $3 OR name LIKE $4 ESCAPE '\\')`,
    [parentId, userId, desiredName, `${baseName.replace(/([%_\\])/g, '\\$1')} (%)${ext.replace(/([%_\\])/g, '\\$1')}`]
  );
  const occupied = new Set(res.rows.map(row => row.name.toLocaleLowerCase()));
  if (!occupied.has(desiredName.toLocaleLowerCase())) return desiredName;
  for (let counter = 1; counter <= 10000; counter += 1) {
    const candidate = generateUniqueName(baseName, ext, counter);
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error('Too many duplicate names in database');
}

export {
  SORT_FIELDS,
  buildOrderClause,
  buildKeysetPage,
  finishKeysetPage,
  calculateFolderSize,
  fillFolderSizes,
  generateUniqueName,
  getUniqueDbFileName,
};
