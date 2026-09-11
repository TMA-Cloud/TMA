import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import storage from '../../utils/storageDriver.js';

/**
 * Cleanup expired trash files (older than 15 days)
 */
async function cleanupExpiredTrash({ batchSize = 500, maxBatches = 100, maxRuntimeMs = 45 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  let batches = 0;
  let deletedFiles = 0;
  let deletedFolders = 0;
  while (batches < maxBatches && Date.now() - startedAt < maxRuntimeMs) {
    const expired = await pool.query(
      `SELECT id, path FROM files
        WHERE type = 'file'
          AND deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'
        ORDER BY deleted_at, id LIMIT $1`,
      [batchSize]
    );
    if (expired.rows.length === 0) break;

    const keys = expired.rows.filter(file => file.path).map(file => file.path);
    try {
      if (typeof storage.deleteObjects === 'function') {
        const result = await storage.deleteObjects(keys);
        if (result.errors.length > 0) throw new Error(`${result.errors.length} object deletion(s) failed`);
      } else {
        await Promise.all(keys.map(key => storage.deleteObject(key)));
      }
    } catch (error) {
      logger.error({ err: error, count: keys.length }, '[Trash] Error deleting object batch');
      // Some deletes may already have succeeded, but S3 deletion is idempotent.
      // Keep every DB row so the next cleanup safely retries the whole batch.
      throw error;
    }
    await pool.query(
      `DELETE FROM files
        WHERE id = ANY($1::text[])
          AND type = 'file'
          AND deleted_at < NOW() - INTERVAL '15 days'`,
      [expired.rows.map(file => file.id)]
    );
    deletedFiles += expired.rows.length;
    batches += 1;
    if (expired.rows.length < batchSize) break;
  }

  // Remove folders only after their children are gone. Deleting an arbitrary
  // folder batch first would let the FK cascade remove file rows whose objects
  // were not included in that storage batch.
  while (batches < maxBatches && Date.now() - startedAt < maxRuntimeMs) {
    const folderBatch = await pool.query(
      `WITH doomed AS (
         SELECT f.id
           FROM files f
          WHERE f.type = 'folder'
            AND f.deleted_at IS NOT NULL
            AND f.deleted_at < NOW() - INTERVAL '15 days'
            AND NOT EXISTS (SELECT 1 FROM files child WHERE child.parent_id = f.id)
          ORDER BY f.deleted_at, f.id
          LIMIT $1
       )
       DELETE FROM files f USING doomed d
        WHERE f.id = d.id
       RETURNING f.id`,
      [batchSize]
    );
    deletedFolders += folderBatch.rows.length;
    batches += 1;
    if (folderBatch.rows.length < batchSize) break;
  }
  const hasMore = batches >= maxBatches || Date.now() - startedAt >= maxRuntimeMs;
  logger.info({ deletedFiles, deletedFolders, batches, hasMore }, '[Trash] Cleanup slice completed');
  return { deletedFiles, deletedFolders, batches, hasMore };
}

// Unattended orphan cleanup used to live here but could destroy an in-flight
// upload whose row wasn't inserted yet; replaced by the admin-driven
// review-then-delete flow in `file.orphan.model.js`.

export { cleanupExpiredTrash };
