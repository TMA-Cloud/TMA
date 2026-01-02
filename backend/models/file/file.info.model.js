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
    `SELECT id, name, type, parent_id FROM files 
     WHERE id = ANY($1) AND user_id = $2 ${deletedClause}`,
    [fileIds, userId]
  );

  return result.rows.map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    parentId: f.parent_id,
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

module.exports = {
  getFileInfo,
  getTargetFolderName,
};
