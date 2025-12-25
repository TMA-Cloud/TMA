const pool = require('../../config/db');
const path = require('path');
const {
  invalidateFileCache,
  invalidateSearchCache,
  deleteCache,
  deleteCachePattern,
  cacheKeys,
} = require('../../utils/cache');
const { buildOrderClause, fillFolderSizes } = require('./file.utils.model');
const { getRecursiveIds } = require('./file.metadata.model');

/**
 * Delete files (soft delete - move to trash)
 */
async function deleteFiles(ids, userId) {
  // Get parent IDs before deleting for cache invalidation
  const parentsResult = await pool.query(
    'SELECT DISTINCT parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
    [ids, userId]
  );
  const parentIds = parentsResult.rows.map(r => r.parent_id).filter(p => p !== null);

  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  await pool.query(
    'UPDATE files SET deleted_at = NOW() WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL',
    [allIds, userId]
  );

  // Invalidate cache for all affected parent folders
  await invalidateFileCache(userId);
  for (const parentId of parentIds) {
    await invalidateFileCache(userId, parentId);
    // Invalidate folder size cache for parent folders
    await deleteCache(cacheKeys.folderSize(parentId, userId));
  }
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  // Invalidate starred, shared, and trash caches
  await deleteCachePattern(`files:${userId}:starred:*`);
  await deleteCachePattern(`files:${userId}:shared:*`);
  await deleteCachePattern(`files:${userId}:trash:*`);
  // Invalidate folder size caches for deleted folders
  for (const id of allIds) {
    await deleteCachePattern(`folder:${userId}:${id}:*`);
  }
}

/**
 * Get files in trash
 */
async function getTrashFiles(userId, sortBy = 'deletedAt', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const res = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared, deleted_at AS "deletedAt", parent_id AS "parentId" FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL ${orderClause}`,
    [userId]
  );
  const files = res.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

/**
 * Get all recursive IDs for files in trash (including children)
 */
async function getRecursiveTrashIds(ids, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NOT NULL
       UNION ALL
       SELECT f.id, f.parent_id FROM files f JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND f.deleted_at IS NOT NULL
     )
     SELECT id FROM sub`,
    [ids, userId]
  );
  return res.rows.map(r => r.id);
}

/**
 * Restore files from trash to their original location (or root if parent no longer exists)
 * Handles name conflicts by renaming restored files
 */
async function restoreFiles(ids, userId) {
  const allIds = await getRecursiveTrashIds(ids, userId);
  if (allIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all files to restore with their parent info
    const filesToRestore = await client.query(
      'SELECT id, name, type, parent_id, path FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NOT NULL',
      [allIds, userId]
    );

    // Process files in order: restore parents first, then children
    // Sort by parent_id nulls first, then by id to ensure consistent ordering
    const sortedFiles = filesToRestore.rows.sort((a, b) => {
      if (a.parent_id === null && b.parent_id !== null) return -1;
      if (a.parent_id !== null && b.parent_id === null) return 1;
      return a.id.localeCompare(b.id);
    });

    for (const file of sortedFiles) {
      let targetParentId = file.parent_id;

      // Check if parent still exists and is not deleted
      if (targetParentId) {
        const parentCheck = await client.query(
          'SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
          [targetParentId, userId]
        );

        // If parent doesn't exist or is deleted, restore to root
        if (parentCheck.rows.length === 0) {
          targetParentId = null;
        }
      }

      // Check for name conflicts in target location
      const conflictCheck = await client.query(
        'SELECT id, name FROM files WHERE name = $1 AND user_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL',
        [file.name, userId, targetParentId]
      );

      let finalName = file.name;
      if (conflictCheck.rows.length > 0) {
        // Name conflict exists, generate unique name
        const ext = path.extname(file.name);
        const baseName = path.basename(file.name, ext);
        let counter = 1;
        let nameExists = true;

        while (nameExists) {
          const newName = `${baseName} (${counter})${ext}`;
          const check = await client.query(
            'SELECT id FROM files WHERE name = $1 AND user_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL',
            [newName, userId, targetParentId]
          );
          if (check.rows.length === 0) {
            finalName = newName;
            nameExists = false;
          } else {
            counter++;
            if (counter > 10000) {
              throw new Error('Too many duplicate names');
            }
          }
        }
      }

      // Update name if it was changed due to conflict
      if (finalName !== file.name) {
        await client.query('UPDATE files SET name = $1 WHERE id = $2 AND user_id = $3', [finalName, file.id, userId]);
      }

      // Restore file: clear deleted_at and update parent_id
      await client.query(
        'UPDATE files SET deleted_at = NULL, parent_id = $1, modified = NOW() WHERE id = $2 AND user_id = $3',
        [targetParentId, file.id, userId]
      );
    }

    await client.query('COMMIT');

    // Invalidate cache after restore
    await invalidateFileCache(userId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Permanently delete files from trash
 */
async function permanentlyDeleteFiles(ids, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  const files = await pool.query('SELECT id, path, type FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [
    allIds,
    userId,
  ]);

  const fs = require('fs');
  const { resolveFilePath } = require('../../utils/filePath');
  const { logger } = require('../../config/logger');

  // Delete files first, then folders
  const foldersToDelete = [];

  for (const f of files.rows) {
    if (!f.path) continue;

    try {
      if (f.type === 'file') {
        // Resolve file path (handles both relative and absolute paths)
        const filePath = resolveFilePath(f.path);
        await fs.promises.unlink(filePath);
      } else if (f.type === 'folder') {
        // For folders, we'll delete them after files are deleted
        // Only delete custom drive folders (those with absolute paths)
        if (path.isAbsolute(f.path)) {
          foldersToDelete.push(f.path);
        }
      }
    } catch (error) {
      // Log error but continue with other deletions
      logger.error(`[File] Error deleting ${f.type} ${f.path}:`, error.message);
    }
  }

  // Delete folders (in reverse order to handle nested folders)
  // Sort by path length descending so deeper folders are deleted first
  foldersToDelete.sort((a, b) => b.length - a.length);
  for (const folderPath of foldersToDelete) {
    try {
      // Check if folder is empty before deleting
      const contents = await fs.promises.readdir(folderPath);
      if (contents.length === 0) {
        await fs.promises.rmdir(folderPath);
      }
    } catch (error) {
      // Folder might not be empty or already deleted, skip
      logger.error(`[File] Error deleting folder ${folderPath}:`, error.message);
    }
  }

  await pool.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [allIds, userId]);

  // Invalidate cache after permanent deletion
  await invalidateFileCache(userId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
}

module.exports = {
  deleteFiles,
  getTrashFiles,
  restoreFiles,
  permanentlyDeleteFiles,
};
