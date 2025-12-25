const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { getCache, setCache, cacheKeys, DEFAULT_TTL } = require('../../utils/cache');
const { getUserCustomDrive } = require('./file.cache.model');

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
  const size = parseInt(res.rows[0].size, 10) || 0;

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

/**
 * Gets the folder path for a parent folder ID
 * Returns the absolute path if it's a custom drive folder, or null if regular folder
 */
async function getFolderPath(parentId, userId) {
  const customDrive = await getUserCustomDrive(userId);

  if (!parentId) {
    return customDrive.enabled && customDrive.path ? customDrive.path : null;
  }

  const result = await pool.query('SELECT path, type FROM files WHERE id = $1 AND user_id = $2', [parentId, userId]);

  if (result.rows.length === 0) {
    return customDrive.enabled && customDrive.path ? customDrive.path : null;
  }

  const folder = result.rows[0];

  // If it's a custom drive folder (has absolute path), use it
  if (folder.path && path.isAbsolute(folder.path)) {
    return folder.path;
  }

  // If custom drive is enabled but folder doesn't have path, use custom drive root
  // For regular folders, we'll need to build the path by traversing up
  if (customDrive.enabled && customDrive.path) {
    // Try to build path by traversing parent chain
    const folderPath = await buildFolderPath(parentId, userId);
    return folderPath || customDrive.path;
  }

  return null;
}

/**
 * Builds the folder path by traversing the parent chain
 */
async function buildFolderPath(folderId, userId) {
  const customDrive = await getUserCustomDrive(userId);

  if (!customDrive.enabled || !customDrive.path) {
    return null;
  }

  const pathParts = [];
  let currentId = folderId;

  // Traverse up the parent chain to build the path
  while (currentId) {
    const result = await pool.query('SELECT name, parent_id, path FROM files WHERE id = $1 AND user_id = $2', [
      currentId,
      userId,
    ]);

    if (result.rows.length === 0) break;

    const folder = result.rows[0];

    // If we hit a custom drive folder (has absolute path), use it as base
    if (folder.path && path.isAbsolute(folder.path)) {
      return folder.path;
    }

    pathParts.unshift(folder.name);
    currentId = folder.parent_id;

    // Safety check to avoid infinite loops
    if (pathParts.length > 100) break;
  }

  // Build path from custom drive root
  if (pathParts.length > 0) {
    return path.join(customDrive.path, ...pathParts);
  }

  return customDrive.path;
}

/**
 * Generates a unique filename if the file already exists
 */
async function getUniqueFilename(filePath, _folderPath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  let finalPath = filePath;
  let counter = 1;

  while (
    await fs.promises
      .access(finalPath)
      .then(() => true)
      .catch(() => false)
  ) {
    const newName = `${baseName} (${counter})${ext}`;
    finalPath = path.join(dir, newName);
    counter++;

    // Safety limit
    if (counter > 10000) {
      throw new Error('Too many duplicate files');
    }
  }

  return finalPath;
}

module.exports = {
  SORT_FIELDS,
  buildOrderClause,
  calculateFolderSize,
  fillFolderSizes,
  getFolderPath,
  buildFolderPath,
  getUniqueFilename,
};
