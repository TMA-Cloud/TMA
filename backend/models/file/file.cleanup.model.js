const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../../config/paths');
const { resolveFilePath } = require('../../utils/filePath');
const { logger } = require('../../config/logger');

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
        // Resolve file path (handles both relative and absolute paths)
        const filePath = resolveFilePath(f.path);
        await fs.promises.unlink(filePath);
      } else if (f.type === 'folder') {
        // For folders, collect them for deletion after files
        if (path.isAbsolute(f.path)) {
          foldersToDelete.push(f.path);
        }
      }
    } catch (error) {
      // Log error but continue
      logger.error(`[Trash] Error cleaning up ${f.type} ${f.path}:`, error.message);
    }
  }

  // Delete folders (in reverse order)
  foldersToDelete.sort((a, b) => b.length - a.length);
  for (const folderPath of foldersToDelete) {
    try {
      const contents = await fs.promises.readdir(folderPath);
      if (contents.length === 0) {
        await fs.promises.rmdir(folderPath);
      }
    } catch (error) {
      logger.error(`[Trash] Error deleting folder ${folderPath}:`, error.message);
    }
  }

  await pool.query("DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'");
}

/**
 * Cleanup orphan files (files in database but not on disk, or files on disk but not in database)
 */
async function cleanupOrphanFiles() {
  const uploadsDir = UPLOAD_DIR;
  let diskFiles = [];
  try {
    diskFiles = await fs.promises.readdir(uploadsDir);
  } catch {
    diskFiles = [];
  }
  const diskSet = new Set(diskFiles);

  // Only check files in UPLOAD_DIR, not custom drive files (which have absolute paths)
  const dbRes = await pool.query("SELECT id, path FROM files WHERE type = 'file' AND path IS NOT NULL");
  const dbSet = new Set();
  for (const row of dbRes.rows) {
    if (!row.path) continue;

    // Skip custom drive files (they have absolute paths, not relative to UPLOAD_DIR)
    if (path.isAbsolute(row.path)) {
      continue;
    }

    dbSet.add(row.path);
    // Only delete if it's a regular upload file (relative path) that doesn't exist on disk
    if (!diskSet.has(row.path)) {
      await pool.query('DELETE FROM files WHERE id = $1', [row.id]);
    }
  }

  // Clean up files on disk that aren't in database
  for (const file of diskFiles) {
    if (!dbSet.has(file)) {
      try {
        await fs.promises.unlink(path.join(uploadsDir, file));
      } catch {
        // Ignore deletion errors for orphan cleanup
      }
    }
  }
}

module.exports = {
  cleanupExpiredTrash,
  cleanupOrphanFiles,
};
