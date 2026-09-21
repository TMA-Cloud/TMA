import path from 'path';

import pool from '../../config/db.js';

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

export { SORT_FIELDS, buildOrderClause, buildKeysetPage, finishKeysetPage, generateUniqueName, getUniqueDbFileName };
