const pool = require('../../config/db');
const fs = require('fs');
const path = require('path');
const { safeUnlink } = require('../../utils/fileCleanup');
const { generateId } = require('../../utils/id');
const { UPLOAD_DIR } = require('../../config/paths');
const { resolveFilePath, isFilePathEncrypted } = require('../../utils/filePath');
const { logger } = require('../../config/logger');
const { invalidateFileCache, invalidateSearchCache, deleteCache, cacheKeys } = require('../../utils/cache');
const { getUserCustomDrive } = require('./file.cache.model');
const { getFolderPath, getUniqueFilename, getUniqueFolderPath } = require('./file.utils.model');
const { encryptFile, copyEncryptedFile } = require('../../utils/fileEncryption');

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

        // Ensure destination directory exists via agent
        const {
          agentPathExists,
          agentMkdir,
          agentReadFileStream,
          agentWriteFileStream,
        } = require('../../utils/agentFileOperations');
        const dirExists = await agentPathExists(destDir);
        if (!dirExists) {
          await agentMkdir(destDir);
        }

        // Handle duplicate filenames using utility function (via agent)
        const destPath = await getUniqueFilename(path.join(destDir, file.name), destDir, true); // Use agent API

        // Stream source file to destination via agent (memory efficient for large files)
        const sourceStream = agentReadFileStream(sourcePath);
        await agentWriteFileStream(destPath, sourceStream);
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
        // If custom drive copy fails, clean up orphaned file via agent
        logger.error('[File] Error copying file to custom drive:', error);
        // Clean up the file that was copied via agent but not in database
        if (newPath && path.isAbsolute(newPath)) {
          const { agentDeletePath } = require('../../utils/agentFileOperations');
          try {
            await agentDeletePath(newPath);
          } catch (cleanupError) {
            logger.warn({ newPath, error: cleanupError.message }, 'Failed to clean up orphaned file via agent');
          }
        }
        // Re-throw the error instead of falling back to avoid violating custom drive invariant
        // Custom drive users must have all files in their custom drive path
        throw error;
      }
    } else {
      // Regular copy to UPLOAD_DIR
      const ext = path.extname(file.name);
      storageName = newId + ext;
      const destPath = path.join(UPLOAD_DIR, storageName);
      try {
        const isSourceEncrypted = isFilePathEncrypted(file.path);

        if (isSourceEncrypted) {
          // Copy encrypted file by decrypting and re-encrypting in a single pipeline
          // This avoids writing plaintext to disk (more secure and faster)
          await copyEncryptedFile(sourcePath, destPath);
        } else {
          // Source is unencrypted (custom-drive), copy to temp then encrypt
          const tempPath = destPath + '.tmp';
          await fs.promises.copyFile(sourcePath, tempPath);
          await encryptFile(tempPath, destPath);
        }
      } catch (error) {
        logger.error('Failed to copy file:', error);
        // Clean up any temporary files
        try {
          const tempFiles = [destPath, destPath + '.tmp'];
          for (const tempFile of tempFiles) {
            await safeUnlink(tempFile);
          }
        } catch (_cleanupError) {
          // Ignore cleanup errors
        }
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

        // Handle duplicate folder names using utility function (via agent)
        finalPath = await getUniqueFolderPath(folderPath, true); // Use agent API
        const { agentMkdir } = require('../../utils/agentFileOperations');
        await agentMkdir(finalPath);
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
        // If custom drive folder creation fails, clean up orphaned folder via agent
        logger.error('[File] Error creating folder in custom drive during copy:', error);
        try {
          // Clean up the folder that was created via agent but not in database
          if (finalPath) {
            const { agentDeletePath } = require('../../utils/agentFileOperations');
            await agentDeletePath(finalPath).catch(() => {
              // Ignore cleanup errors (folder might not be empty or already deleted)
            });
          }
        } catch (cleanupError) {
          logger.warn(
            { finalPath, error: cleanupError.message },
            'Failed to clean up orphaned custom drive folder during copy via agent'
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
    await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache
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
