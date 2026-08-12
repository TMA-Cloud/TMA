import fs from 'fs';
import path from 'path';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { resolveFilePath } from '../../utils/filePath.js';
import storage from '../../utils/storageDriver.js';

/**
 * Cleanup expired trash files (older than 15 days)
 */
async function cleanupExpiredTrash() {
  const expired = await pool.query(
    "SELECT id, path, type FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'"
  );

  const foldersToDelete = [];

  for (const f of expired.rows) {
    if (!f.path) continue;

    try {
      if (f.type === 'file') {
        if (storage.useS3()) {
          await storage.deleteObject(f.path);
        } else {
          const filePath = resolveFilePath(f.path);
          await fs.promises.unlink(filePath);
        }
      } else if (f.type === 'folder') {
        if (path.isAbsolute(f.path)) {
          foldersToDelete.push(f.path);
        }
      }
    } catch (error) {
      logger.error(`[Trash] Error cleaning up ${f.type} ${f.path}:`, error.message);
    }
  }

  foldersToDelete.sort((a, b) => b.length - a.length);
  for (const folderPath of foldersToDelete) {
    try {
      await fs.promises.rm(folderPath, { recursive: true, force: true });
    } catch (error) {
      logger.error(`[Trash] Error deleting folder ${folderPath}:`, error.message);
    }
  }

  await pool.query("DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'");
}

// Orphan cleanup used to live here as an unattended job. It compared storage
// against the database and deleted both sides of any mismatch, which meant an
// upload or paste whose row had not been inserted yet could be destroyed
// mid-write. It is replaced by the review-then-delete flow in
// `file.orphan.model.js`, driven by the first user from the admin UI.

export { cleanupExpiredTrash };
