const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../../config/paths');
const { resolveFilePath } = require('../../utils/filePath');
const { logger } = require('../../config/logger');
const storage = require('../../utils/storageDriver');

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

/**
 * Cleanup orphan files (files in database but not on disk/S3, or files on disk/S3 but not in database).
 * S3: uses listKeysPaginated to avoid loading the entire bucket into RAM at scale.
 */
async function cleanupOrphanFiles() {
  if (storage.useS3()) {
    const dbRes = await pool.query(
      "SELECT id, path FROM files WHERE type = 'file' AND path IS NOT NULL AND path NOT LIKE '/%'"
    );
    const dbSet = new Set(dbRes.rows.map(r => r.path).filter(Boolean));

    for (const row of dbRes.rows) {
      if (!row.path) continue;
      const existsInS3 = await storage.exists(row.path);
      if (!existsInS3) {
        await pool.query('DELETE FROM files WHERE id = $1', [row.id]);
      }
    }

    for await (const page of storage.listKeysPaginated(1000)) {
      for (const key of page) {
        if (!dbSet.has(key)) {
          try {
            await storage.deleteObject(key);
          } catch {
            // Ignore deletion errors for orphan cleanup
          }
        }
      }
    }
    return;
  }

  const uploadsDir = UPLOAD_DIR;
  let diskFiles;
  try {
    diskFiles = await fs.promises.readdir(uploadsDir);
  } catch {
    diskFiles = [];
  }
  const diskSet = new Set(diskFiles);

  const dbRes = await pool.query("SELECT id, path FROM files WHERE type = 'file' AND path IS NOT NULL");
  const dbSet = new Set();
  for (const row of dbRes.rows) {
    if (!row.path) continue;
    if (path.isAbsolute(row.path)) continue;

    dbSet.add(row.path);
    if (!diskSet.has(row.path)) {
      await pool.query('DELETE FROM files WHERE id = $1', [row.id]);
    }
  }

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
