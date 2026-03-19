/**
 * File info query utilities
 * Common patterns for querying file information
 */

import pool from '../../config/db.js';

/**
 * Get file information for multiple files
 * @param {string[]} fileIds - Array of file IDs
 * @param {string} userId - User ID
 * @param {boolean} includeDeleted - Whether to include deleted files (default: false)
 * @returns {Promise<Array>} Array of file info objects with id, name, type, parentId
 */
async function getFileInfo(fileIds, userId, includeDeleted = false) {
  const deletedClause = includeDeleted ? '' : 'AND deleted_at IS NULL';
  const result = await pool.query(
    `SELECT id, name, type, parent_id, size, modified 
     FROM files 
     WHERE id = ANY($1) AND user_id = $2 ${deletedClause}`,
    [fileIds, userId]
  );

  return result.rows.map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    parentId: f.parent_id,
    size: f.size,
    modified: f.modified,
  }));
}

/**
 * Get folder name segments for the given folder id, from root -> folder.
 * Used for the "Location" UI (e.g. "Home / FolderA / FolderB").
 *
 * Note: folderId is a folder (parent of the item). When folderId is null, it
 * represents the root and returns an empty segment list.
 */
async function getFolderPathSegments(folderId, userId) {
  if (!folderId) return [];

  const result = await pool.query(
    `
      WITH RECURSIVE chain AS (
        SELECT id, name, parent_id, 0 AS depth
        FROM files
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        UNION ALL
        SELECT f.id, f.name, f.parent_id, chain.depth + 1 AS depth
        FROM files f
        JOIN chain ON chain.parent_id = f.id
        WHERE f.user_id = $2 AND f.deleted_at IS NULL
      )
      SELECT name
      FROM chain
      ORDER BY depth DESC;
    `,
    [folderId, userId]
  );

  return result.rows.map(r => r.name);
}

/**
 * Get target folder name for a given folder ID
 * @param {string} folderId - Folder ID (can be null for root)
 * @param {string} userId - User ID
 * @returns {Promise<string>} Folder name or 'Root' if null
 */
async function getTargetFolderName(folderId, userId) {
  if (!folderId) {
    return 'Root';
  }

  const result = await pool.query('SELECT name FROM files WHERE id = $1 AND user_id = $2', [folderId, userId]);
  return result.rows[0]?.name || 'Root';
}

/**
 * Resolves the target folder ID for a paste operation.
 * If the targetId refers to a file, it returns the file's parent_id.
 * If the targetId refers to a folder, it returns the targetId itself.
 * If targetId is null, it returns null (representing the root).
 * @param {string|null} targetId - The ID of the item the user intends to paste into/onto.
 * @param {string} userId - The user ID.
 * @returns {Promise<string|null>} The ID of the actual parent folder for the paste operation.
 */
async function resolveTargetFolderId(targetId, userId) {
  if (!targetId) {
    return null; // Root folder
  }

  const result = await pool.query('SELECT type, parent_id FROM files WHERE id = $1 AND user_id = $2', [
    targetId,
    userId,
  ]);

  if (result.rows.length === 0) {
    return null; // Target not found, default to root or handle as error? For now, root.
  }

  const targetEntry = result.rows[0];

  if (targetEntry.type === 'file') {
    return targetEntry.parent_id; // Return the parent of the file
  } else {
    return targetId; // It's a folder, return its own ID
  }
}

export { getFileInfo, getFolderPathSegments, getTargetFolderName, resolveTargetFolderId };
