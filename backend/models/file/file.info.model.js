/**
 * File info query utilities
 * Common patterns for querying file information
 */

const pool = require('../../config/db');

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
    `SELECT id, name, type, parent_id, size FROM files 
     WHERE id = ANY($1) AND user_id = $2 ${deletedClause}`,
    [fileIds, userId]
  );

  return result.rows.map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    parentId: f.parent_id,
    size: f.size,
  }));
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

module.exports = {
  getFileInfo,
  getTargetFolderName,
  resolveTargetFolderId,
};
