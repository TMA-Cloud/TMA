import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import storage from '../../utils/storageDriver.js';

/**
 * Cleanup expired trash files (older than 15 days)
 */
async function cleanupExpiredTrash() {
  const expired = await pool.query(
    "SELECT id, path, type FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'"
  );

  for (const f of expired.rows) {
    if (!f.path) continue;

    try {
      if (f.type === 'file') {
        await storage.deleteObject(f.path);
      }
    } catch (error) {
      logger.error(`[Trash] Error cleaning up ${f.type} ${f.path}:`, error.message);
    }
  }

  await pool.query("DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'");
}

// Unattended orphan cleanup used to live here but could destroy an in-flight
// upload whose row wasn't inserted yet; replaced by the admin-driven
// review-then-delete flow in `file.orphan.model.js`.

export { cleanupExpiredTrash };
