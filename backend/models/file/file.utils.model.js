const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { getCache, setCache, cacheKeys, DEFAULT_TTL } = require('../../utils/cache');

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

/**
 * Gets the folder path for a parent folder ID (for path helpers).
 * All paths are relative to UPLOAD_DIR; returns null when no absolute path applies.
 */
async function getFolderPath(parentId, userId) {
  if (!parentId) {
    return null;
  }

  const result = await pool.query('SELECT path, type, parent_id FROM files WHERE id = $1 AND user_id = $2', [
    parentId,
    userId,
  ]);

  if (result.rows.length === 0) {
    return null;
  }

  const targetEntry = result.rows[0];

  if (targetEntry.type === 'file') {
    if (targetEntry.path && path.isAbsolute(targetEntry.path)) {
      return path.dirname(targetEntry.path);
    }
    return getFolderPath(targetEntry.parent_id, userId);
  }

  if (targetEntry.path && path.isAbsolute(targetEntry.path)) {
    return targetEntry.path;
  }

  return null;
}

/**
 * Builds the folder path by traversing the parent chain.
 * No longer used; returns null (paths are relative to UPLOAD_DIR).
 */
async function buildFolderPath(_folderId, _userId) {
  return null;
}

/**
 * Generates a unique name by appending a counter
 * @param {string} baseName - Base name without extension
 * @param {string} ext - File extension (including dot)
 * @param {number} counter - Counter to append
 * @returns {string} Unique name
 */
function generateUniqueName(baseName, ext, counter) {
  return `${baseName} (${counter})${ext}`;
}

/**
 * Generates a unique filename if the file already exists
 * @param {string} filePath - Full file path to check
 * @param {string} userId - Optional user ID to check database for existing files
 * @returns {Promise<string>} Unique file path
 */
async function getUniqueFilename(filePath, userId = null) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  let finalPath = filePath;
  let counter = 1;

  while (true) {
    let exists;

    exists = await fs.promises
      .access(finalPath)
      .then(() => true)
      .catch(() => false);

    // Also check database if userId is provided
    if (!exists && userId) {
      const absolutePath = path.resolve(finalPath);
      const dbCheck = await pool.query(
        'SELECT id FROM files WHERE path = $1 AND user_id = $2 AND type = $3 AND deleted_at IS NULL',
        [absolutePath, userId, 'file']
      );
      exists = dbCheck.rows.length > 0;
    }

    if (!exists) {
      break; // Path is available
    }

    const newName = generateUniqueName(baseName, ext, counter);
    finalPath = path.join(dir, newName);
    counter++;

    // Safety limit
    if (counter > 10000) {
      throw new Error('Too many duplicate files');
    }
  }

  return finalPath;
}

/**
 * Generates a unique folder name if the folder already exists
 * @param {string} folderPath - Full folder path to check
 * @returns {Promise<string>} Unique folder path
 */
async function getUniqueFolderPath(folderPath) {
  const dir = path.dirname(folderPath);
  const baseName = path.basename(folderPath);

  let finalPath = folderPath;
  let counter = 1;

  while (true) {
    const exists = await fs.promises
      .access(finalPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      break; // Path is available
    }

    const newName = generateUniqueName(baseName, '', counter);
    finalPath = path.join(dir, newName);
    counter++;

    // Safety limit
    if (counter > 10000) {
      throw new Error('Too many duplicate folders');
    }
  }

  return finalPath;
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

module.exports = {
  SORT_FIELDS,
  buildOrderClause,
  calculateFolderSize,
  fillFolderSizes,
  getFolderPath,
  buildFolderPath,
  getUniqueFilename,
  getUniqueFolderPath,
  generateUniqueName,
  getUniqueDbFileName,
};
