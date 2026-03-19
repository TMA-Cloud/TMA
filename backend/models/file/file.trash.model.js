import fs from 'fs';
import path from 'path';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import {
  invalidateFileCache,
  invalidateSearchCache,
  deleteCache,
  deleteCachePattern,
  cacheKeys,
} from '../../utils/cache.js';
import { resolveFilePath } from '../../utils/filePath.js';
import storage from '../../utils/storageDriver.js';

import { getRecursiveIds } from './file.metadata.model.js';
import { buildOrderClause, fillFolderSizes } from './file.utils.model.js';

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
  await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache
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
async function getTrashFiles(userId, sortBy = 'deletedAt', order = 'DESC', topLevelOnly = false) {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order, 'f');

  // When listing trash, we usually don't want to render thousands of child rows
  // for a single deleted folder. Instead, show only "top-level" items where:
  // - the item has no parent, OR
  // - its parent is NOT also in trash.
  //
  const topLevelFilter = topLevelOnly
    ? ` AND (
          f.parent_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM files p
            WHERE p.id = f.parent_id
              AND p.user_id = $1
              AND p.deleted_at IS NOT NULL
          )
        )`
    : '';

  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.size, f.modified, f.mime_type AS "mimeType", f.starred, f.shared, f.deleted_at AS "deletedAt", f.parent_id AS "parentId"
     FROM files f
     WHERE f.user_id = $1
       AND f.deleted_at IS NOT NULL${topLevelFilter}
     ${orderClause}`,
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

    // Process files in parent-first order (by depth within the restore set).
    // This prevents children from being restored before their parent,
    // which would otherwise cause us to restore them to root (and create duplicates).
    const idsSet = new Set(allIds);
    const parentById = new Map(filesToRestore.rows.map(f => [f.id, f.parent_id]));
    const depthMemo = new Map();

    const visiting = new Set();
    const getDepth = id => {
      const cached = depthMemo.get(id);
      if (cached != null) return cached;

      // Defensive: if there is an unexpected cycle in the DB,
      // avoid infinite recursion/stack overflow.
      if (visiting.has(id)) {
        depthMemo.set(id, 0);
        return 0;
      }

      visiting.add(id);

      const parentId = parentById.get(id);
      const depth = !parentId || !idsSet.has(parentId) ? 0 : getDepth(parentId) + 1;

      visiting.delete(id);
      depthMemo.set(id, depth);
      return depth;
    };

    const sortedFiles = filesToRestore.rows.sort((a, b) => {
      const da = getDepth(a.id);
      const db = getDepth(b.id);
      if (da !== db) return da - db;
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
        // Preserve original metadata timestamps/values (e.g. `modified`)
        // and only "undelete" + reattach to the correct parent.
        'UPDATE files SET deleted_at = NULL, parent_id = $1 WHERE id = $2 AND user_id = $3',
        [targetParentId, file.id, userId]
      );
    }

    await client.query('COMMIT');

    // Invalidate cache after restore
    await invalidateFileCache(userId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
    await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache
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

  const filesToDelete = [];
  const foldersToDelete = [];

  for (const f of files.rows) {
    if (!f.path) continue;

    if (f.type === 'file') {
      filesToDelete.push({ key: f.path });
    } else if (f.type === 'folder') {
      if (path.isAbsolute(f.path)) {
        foldersToDelete.push(f.path);
      }
    }
  }

  const fileDeletePromises = filesToDelete.map(async ({ key }) => {
    try {
      if (storage.useS3()) {
        await storage.deleteObject(key);
      } else {
        const resolvedPath = resolveFilePath(key);
        await fs.promises.unlink(resolvedPath);
      }
    } catch (error) {
      logger.error({ err: error, path: key }, `[File] Error deleting file ${key}`);
    }
  });

  await Promise.allSettled(fileDeletePromises);

  foldersToDelete.sort((a, b) => b.length - a.length);
  const folderDeletePromises = foldersToDelete.map(async folderPath => {
    try {
      await fs.promises.rm(folderPath, { recursive: true, force: true });
    } catch (error) {
      logger.error({ err: error, path: folderPath }, `[File] Error deleting folder ${folderPath}`);
    }
  });

  await Promise.allSettled(folderDeletePromises);

  await pool.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [allIds, userId]);

  // Invalidate cache after permanent deletion
  await invalidateFileCache(userId);
  await invalidateSearchCache(userId);
  await deleteCache(cacheKeys.fileStats(userId));
  await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache
}

export { deleteFiles, getTrashFiles, restoreFiles, permanentlyDeleteFiles };
