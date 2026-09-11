import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { invalidateAllFileCaches } from '../../utils/cache.js';
import storage from '../../utils/storageDriver.js';

import { buildKeysetPage, buildOrderClause, finishKeysetPage } from './file.utils.model.js';

/**
 * Delete files (soft delete - move to trash)
 */
async function deleteFiles(ids, userId) {
  const result = await pool.query(
    `WITH RECURSIVE sub(id, visited) AS (
       SELECT id, ARRAY[id] FROM files
        WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT child.id, sub.visited || child.id
         FROM files child JOIN sub ON child.parent_id = sub.id
        WHERE child.user_id = $2 AND child.deleted_at IS NULL AND NOT child.id = ANY(sub.visited)
     )
     UPDATE files SET deleted_at = NOW()
      WHERE user_id = $2 AND id IN (SELECT id FROM sub)
      RETURNING id`,
    [ids, userId]
  );
  await invalidateAllFileCaches(userId);
  return result.rowCount || 0;
}

/**
 * Get files in trash
 */
async function getTrashFiles(userId, sortBy = 'deletedAt', order = 'DESC', topLevelOnly = false, pageOptions = null) {
  const page = pageOptions ? buildKeysetPage(sortBy, order, pageOptions.cursor, 'f', 2, pageOptions.limit) : null;
  const orderClause = page?.orderClause || buildOrderClause(sortBy, order, 'f');

  // Show only top-level trash items (no parent, or parent not also trashed) so
  // a deleted folder doesn't render thousands of child rows.
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
    `SELECT f.id, f.name, f.type,
            CASE WHEN f.type = 'folder' THEN f.aggregate_size ELSE f.size END AS size,
            f.modified, f.accessed_at AS "accessedAt", f.mime_type AS "mimeType", f.starred, f.shared, f.shared_at AS "sharedAt", f.deleted_at AS "deletedAt", f.parent_id AS "parentId"
     FROM files f
     WHERE f.user_id = $1
       AND f.deleted_at IS NOT NULL${topLevelFilter}
       ${page?.whereClause || ''}
     ${orderClause}
     ${page ? `LIMIT ${page.limitParam}` : ''}`,
    [userId, ...(page?.params || [])]
  );
  const files = res.rows;
  return page ? finishKeysetPage(files, page) : files;
}

/**
 * Get all recursive IDs for files in trash (including children)
 */
async function getRecursiveTrashIds(ids, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub(id, parent_id, visited) AS (
       SELECT id, parent_id, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NOT NULL
       UNION ALL
       SELECT f.id, f.parent_id, s.visited || f.id FROM files f JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND f.deleted_at IS NOT NULL AND NOT f.id = ANY(s.visited)
     )
     SELECT id FROM sub`,
    [ids, userId]
  );
  return res.rows.map(r => r.id);
}

async function countFileTree(ids, userId, { deleted = false, allTrash = false } = {}) {
  if (allTrash) {
    const result = await pool.query(
      'SELECT COUNT(*)::integer AS count FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL',
      [userId]
    );
    return result.rows[0]?.count || 0;
  }
  const result = await pool.query(
    `WITH RECURSIVE sub(id, visited) AS (
       SELECT f.id, ARRAY[f.id] FROM files f
        WHERE f.user_id = $2
          AND (($3::boolean AND f.deleted_at IS NOT NULL) OR (NOT $3::boolean AND f.deleted_at IS NULL))
          AND f.id = ANY($1::text[])
       UNION ALL
       SELECT child.id, sub.visited || child.id
         FROM files child JOIN sub ON child.parent_id = sub.id
        WHERE child.user_id = $2
          AND (($3::boolean AND child.deleted_at IS NOT NULL) OR (NOT $3::boolean AND child.deleted_at IS NULL))
          AND NOT child.id = ANY(sub.visited)
     )
     SELECT COUNT(DISTINCT id)::integer AS count FROM sub`,
    [ids || [], userId, deleted]
  );
  return result.rows[0]?.count || 0;
}

/**
 * Restore files from trash to their original location (or root if parent no longer exists)
 * Handles name conflicts by renaming restored files
 */
async function restoreFiles(ids, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE restore_stage ON COMMIT DROP AS
       WITH RECURSIVE sub(id, name, parent_id, depth, visited) AS (
         SELECT id, name, parent_id, 0, ARRAY[id] FROM files
          WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NOT NULL
         UNION ALL
         SELECT child.id, child.name, child.parent_id, sub.depth + 1, sub.visited || child.id
           FROM files child JOIN sub ON child.parent_id = sub.id
          WHERE child.user_id = $2 AND child.deleted_at IS NOT NULL AND NOT child.id = ANY(sub.visited)
       )
       SELECT DISTINCT ON (id) id, name, parent_id, depth,
              NULL::text AS new_parent_id, NULL::text AS new_name
         FROM sub ORDER BY id, depth`,
      [ids, userId]
    );
    const staged = await client.query('SELECT COUNT(*)::integer AS count FROM restore_stage');
    if (staged.rows[0].count === 0) {
      await client.query('COMMIT');
      return 0;
    }
    await client.query(
      `UPDATE restore_stage stage
          SET new_parent_id = CASE
            WHEN stage.parent_id IS NULL THEN NULL
            WHEN EXISTS (SELECT 1 FROM restore_stage parent WHERE parent.id = stage.parent_id) THEN stage.parent_id
            WHEN EXISTS (
              SELECT 1 FROM files parent
               WHERE parent.id = stage.parent_id AND parent.user_id = $1 AND parent.deleted_at IS NULL
            ) THEN stage.parent_id
            ELSE NULL
          END`,
      [userId]
    );
    await client.query(
      `UPDATE restore_stage stage
          SET new_name = CASE WHEN
            EXISTS (
              SELECT 1 FROM files active
               WHERE active.user_id = $1 AND active.deleted_at IS NULL
                 AND active.parent_id IS NOT DISTINCT FROM stage.new_parent_id
                 AND lower(active.name) = lower(stage.name)
            ) OR EXISTS (
              SELECT 1 FROM restore_stage earlier
               WHERE earlier.new_parent_id IS NOT DISTINCT FROM stage.new_parent_id
                 AND lower(earlier.name) = lower(stage.name) AND earlier.id < stage.id
            )
            THEN left(stage.name, 225) || ' (restored-' || stage.id || ')'
            ELSE stage.name END`,
      [userId]
    );
    await client.query(
      `UPDATE files AS f
          SET deleted_at = NULL, parent_id = stage.new_parent_id, name = stage.new_name
         FROM restore_stage stage
        WHERE f.id = stage.id AND f.user_id = $1`,
      [userId]
    );
    await client.query('COMMIT');
    await invalidateAllFileCaches(userId);
    return staged.rows[0].count;
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
async function permanentlyDeleteFiles(ids, userId, { allTrash = false, batchSize = 500 } = {}) {
  const client = await pool.connect();
  let totalDeleted = 0;
  try {
    await client.query('DROP TABLE IF EXISTS delete_stage');
    await client.query(
      `CREATE TEMP TABLE delete_stage ON COMMIT PRESERVE ROWS AS
       WITH RECURSIVE sub(id, path, type, depth, visited) AS (
         SELECT f.id, f.path, f.type, 0, ARRAY[f.id]
           FROM files f
          WHERE f.user_id = $2 AND f.deleted_at IS NOT NULL
            AND (
              ($3::boolean AND NOT EXISTS (
                SELECT 1 FROM files parent
                 WHERE parent.id = f.parent_id AND parent.user_id = $2 AND parent.deleted_at IS NOT NULL
              ))
              OR (NOT $3::boolean AND f.id = ANY($1::text[]))
            )
         UNION ALL
         SELECT child.id, child.path, child.type, sub.depth + 1, sub.visited || child.id
           FROM files child JOIN sub ON child.parent_id = sub.id
          WHERE child.user_id = $2 AND child.deleted_at IS NOT NULL AND NOT child.id = ANY(sub.visited)
       )
       SELECT DISTINCT ON (id) id, path, type, depth FROM sub ORDER BY id, depth DESC`,
      [ids || [], userId, allTrash]
    );
    await client.query('CREATE INDEX delete_stage_depth_idx ON delete_stage(depth DESC, id)');

    for (;;) {
      const batch = await client.query('SELECT id, path, type FROM delete_stage ORDER BY depth DESC, id LIMIT $1', [
        batchSize,
      ]);
      if (batch.rows.length === 0) break;
      const keys = batch.rows.filter(row => row.type === 'file' && row.path).map(row => row.path);
      try {
        if (keys.length > 0) {
          const result = await storage.deleteObjects(keys);
          if (result.errors.length > 0) throw new Error(`${result.errors.length} object deletion(s) failed`);
        }
      } catch (error) {
        logger.error({ err: error, count: keys.length }, '[File] Error deleting object batch');
        throw error;
      }
      const batchIds = batch.rows.map(row => row.id);
      await client.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [batchIds, userId]);
      await client.query('DELETE FROM delete_stage WHERE id = ANY($1::text[])', [batchIds]);
      totalDeleted += batchIds.length;
    }
    await client.query('DROP TABLE delete_stage');
    await invalidateAllFileCaches(userId);
    return totalDeleted;
  } finally {
    await client.query('DROP TABLE IF EXISTS delete_stage').catch(() => {});
    client.release();
  }
}

export { deleteFiles, getTrashFiles, getRecursiveTrashIds, countFileTree, restoreFiles, permanentlyDeleteFiles };
