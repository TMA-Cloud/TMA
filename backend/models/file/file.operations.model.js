const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { generateId } = require('../../utils/id');
const { UPLOAD_DIR } = require('../../config/paths');
const { resolveFilePath } = require('../../utils/filePath');
const { logger } = require('../../config/logger');
const { invalidateFileCache, invalidateSearchCache, deleteCache, cacheKeys } = require('../../utils/cache');
const { getUserCustomDrive } = require('./file.cache.model');
const { getFolderPath } = require('./file.utils.model');

/**
 * Move files to a different parent folder
 */
async function moveFiles(ids, parentId = null, userId) {
  // Get old parent IDs before moving
  const oldParentsResult = await pool.query(
    'SELECT DISTINCT parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
    [ids, userId]
  );
  const oldParentIds = oldParentsResult.rows.map(r => r.parent_id);

  await pool.query('UPDATE files SET parent_id = $1, modified = NOW() WHERE id = ANY($2::text[]) AND user_id = $3', [
    parentId,
    ids,
    userId,
  ]);

  // Invalidate cache for both old and new parent folders
  await invalidateFileCache(userId, parentId);
  for (const oldParentId of oldParentIds) {
    if (oldParentId !== parentId) {
      await invalidateFileCache(userId, oldParentId);
    }
  }
  await invalidateSearchCache(userId);
}

/**
 * Copy a single file or folder entry (recursive for folders)
 */
async function copyEntry(id, parentId, userId, client = null) {
  const dbClient = client || pool;
  const res = await dbClient.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (res.rows.length === 0) return null;
  const file = res.rows[0];
  const newId = generateId(16);
  let storageName = null;
  let newPath = null;

  if (file.type === 'file') {
    // Get source file path (handles both relative and absolute)
    const sourcePath = resolveFilePath(file.path);

    const customDrive = await getUserCustomDrive(userId);

    if (customDrive.enabled && customDrive.path) {
      // If custom drive is enabled, copy to custom drive with original name
      try {
        const folderPath = await getFolderPath(parentId, userId);
        const destDir = folderPath || customDrive.path;

        // Ensure destination directory exists
        try {
          await fs.promises.access(destDir);
        } catch {
          await fs.promises.mkdir(destDir, { recursive: true });
        }

        // Handle duplicate filenames
        let destPath = path.join(destDir, file.name);
        let counter = 1;
        while (
          await fs.promises
            .access(destPath)
            .then(() => true)
            .catch(() => false)
        ) {
          const ext = path.extname(file.name);
          const baseName = path.basename(file.name, ext);
          const newName = `${baseName} (${counter})${ext}`;
          destPath = path.join(destDir, newName);
          counter++;
          if (counter > 10000) {
            throw new Error('Too many duplicate files');
          }
        }

        await fs.promises.copyFile(sourcePath, destPath);
        newPath = path.resolve(destPath);

        // Get the actual filename (in case it was changed due to duplicates)
        const actualName = path.basename(destPath);

        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            actualName,
            file.type,
            file.size,
            file.mime_type,
            newPath,
            parentId,
            userId,
            file.starred,
            file.shared,
          ]
        );
      } catch (error) {
        // If custom drive copy fails, clean up orphaned file on disk
        logger.error('[File] Error copying file to custom drive:', error);
        try {
          // Clean up the file that was copied to disk but not in database
          if (newPath && path.isAbsolute(newPath)) {
            await fs.promises.unlink(newPath).catch(() => {
              // Ignore cleanup errors (file might not exist or already deleted)
            });
          }
        } catch (cleanupError) {
          logger.warn(
            { newPath, error: cleanupError.message },
            'Failed to clean up orphaned custom drive file during copy'
          );
        }
        // Re-throw the error instead of falling back to avoid violating custom drive invariant
        // Custom drive users must have all files in their custom drive path
        throw error;
      }
    } else {
      // Regular copy to UPLOAD_DIR
      const ext = path.extname(file.name);
      storageName = newId + ext;
      try {
        await fs.promises.copyFile(sourcePath, path.join(UPLOAD_DIR, storageName));
      } catch (error) {
        logger.error('Failed to copy file:', error);
        throw new Error('File copy operation failed');
      }
      newPath = storageName;

      await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId, file.name, file.type, file.size, file.mime_type, newPath, parentId, userId, file.starred, file.shared]
      );
    }
  } else if (file.type === 'folder') {
    // For folders created in custom drive, we need to create them on disk
    const customDrive = await getUserCustomDrive(userId);

    if (customDrive.enabled && customDrive.path) {
      let finalPath = null; // Declare outside try block to safely access in catch
      try {
        const parentPath = await getFolderPath(parentId, userId);
        const folderPath = parentPath ? path.join(parentPath, file.name) : path.join(customDrive.path, file.name);

        // Handle duplicate folder names
        finalPath = folderPath;
        let counter = 1;
        while (
          await fs.promises
            .access(finalPath)
            .then(() => true)
            .catch(() => false)
        ) {
          const newName = `${file.name} (${counter})`;
          finalPath = parentPath ? path.join(parentPath, newName) : path.join(customDrive.path, newName);
          counter++;
          if (counter > 10000) {
            throw new Error('Too many duplicate folders');
          }
        }

        await fs.promises.mkdir(finalPath, { recursive: true });
        const actualName = path.basename(finalPath);
        newPath = path.resolve(finalPath);

        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            actualName,
            file.type,
            file.size,
            file.mime_type,
            newPath,
            parentId,
            userId,
            file.starred,
            file.shared,
          ]
        );
      } catch (error) {
        // If custom drive folder creation fails, clean up orphaned folder on disk
        logger.error('[File] Error creating folder in custom drive during copy:', error);
        try {
          // Clean up the folder that was created on disk but not in database
          if (finalPath) {
            await fs.promises.rmdir(finalPath).catch(() => {
              // Ignore cleanup errors (folder might not be empty or already deleted)
            });
          }
        } catch (cleanupError) {
          logger.warn(
            { finalPath, error: cleanupError.message },
            'Failed to clean up orphaned custom drive folder during copy'
          );
        }
        // Re-throw the error instead of falling back to avoid duplicate key errors
        throw error;
      }
    } else {
      // Regular folder (no path stored)
      await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId, file.name, file.type, file.size, file.mime_type, null, parentId, userId, file.starred, file.shared]
      );
    }

    // Recursively copy folder contents
    const children = await dbClient.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [id, userId]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId, client);
    }
  }
  return newId;
}

/**
 * Copy files to a different parent folder
 */
async function copyFiles(ids, parentId = null, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      await copyEntry(id, parentId, userId, client);
    }
    await client.query('COMMIT');

    // Invalidate cache after copying
    await invalidateFileCache(userId, parentId);
    await invalidateSearchCache(userId);
    await deleteCache(cacheKeys.fileStats(userId));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  moveFiles,
  copyFiles,
};
