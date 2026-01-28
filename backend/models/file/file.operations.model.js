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
const { getFolderPath, getUniqueFilename, getUniqueFolderPath, getUniqueDbFileName } = require('./file.utils.model');
const { encryptFile, copyEncryptedFile } = require('../../utils/fileEncryption');

/**
 * Move files to a different parent folder
 */
async function moveFiles(ids, parentId = null, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get old parent IDs and file info before moving
    const filesResult = await client.query(
      'SELECT id, parent_id, path, type, name FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
      [ids, userId]
    );
    const filesToMove = filesResult.rows;
    const oldParentIds = [...new Set(filesToMove.map(r => r.parent_id))];

    // Check if user has custom drive enabled (needed for filesystem moves)
    const customDrive = await getUserCustomDrive(userId);

    // Track new paths for entries that are moved on disk (custom-drive absolute paths)
    const movedIds = [];
    const movedNewPaths = [];

    // If custom drive is enabled, move absolute-path entries on disk as well
    // so the custom-drive scanner won't "undo" the move on restart.
    if (customDrive.enabled && customDrive.path && filesToMove.length > 0) {
      const { agentRenamePath, agentPathExists, agentMkdir } = require('../../utils/agentFileOperations');

      // Resolve target parent folder path once (may be null if regular folder hierarchy)
      const targetParentPath = await getFolderPath(parentId, userId);
      const targetBaseDir = targetParentPath || customDrive.path;

      // Ensure destination directory exists
      const destExists = await agentPathExists(targetBaseDir);
      if (!destExists) {
        await agentMkdir(targetBaseDir);
      }

      for (const file of filesToMove) {
        if (!file.path || !path.isAbsolute(file.path)) {
          // Regular (non-custom-drive) entry: DB-only move is fine
          continue;
        }

        const oldPath = path.resolve(file.path);
        let destPath = path.join(targetBaseDir, file.name);

        try {
          if (file.type === 'folder') {
            // For folders, ensure unique destination folder name
            destPath = await getUniqueFolderPath(destPath, true); // useAgent = true
          } else {
            // For files, ensure unique filename at destination
            destPath = await getUniqueFilename(destPath, targetBaseDir, true); // useAgent = true
          }

          // Move on filesystem via agent (OS-level rename is instant, even for large folders)
          await agentRenamePath(oldPath, destPath);

          const absoluteNewPath = path.resolve(destPath);
          movedIds.push(file.id);
          movedNewPaths.push(absoluteNewPath);
        } catch (error) {
          // If filesystem move fails, log and rethrow so the operation fails cleanly.
          // IMPORTANT: we do NOT update the DB for this file unless the agent move succeeded.
          logger.error(
            {
              fileId: file.id,
              oldPath,
              attemptedDestPath: destPath,
              userId,
              err: error.message,
            },
            '[File] Error moving custom-drive entry on disk during moveFiles'
          );
          throw error;
        }
      }
    }

    // Bulk update all files in a single statement.
    // For custom-drive entries, also update their path; for others, keep existing path.
    const allIds = ids;
    const allNewPaths = allIds.map(id => {
      const idx = movedIds.indexOf(id);
      return idx === -1 ? null : movedNewPaths[idx];
    });

    // Use a VALUES table to join ids to new_path values; this keeps updates in one query.
    await client.query(
      `
      UPDATE files f
      SET
        parent_id = $1,
        path = COALESCE(v.new_path, f.path)
      FROM (
        SELECT unnest($2::text[]) AS id, unnest($3::text[]) AS new_path
      ) AS v
      WHERE f.id = v.id AND f.user_id = $4
      `,
      [parentId, allIds, allNewPaths, userId]
    );

    await client.query('COMMIT');

    // Invalidate cache for both old and new parent folders
    await invalidateFileCache(userId, parentId);
    for (const oldParentId of oldParentIds) {
      if (oldParentId !== parentId) {
        await invalidateFileCache(userId, oldParentId);
      }
    }
    await invalidateSearchCache(userId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Copy a single file or folder entry (recursive for folders)
 */
async function copyEntry(id, parentId, userId, client = null, customDrive = null) {
  const dbClient = client || pool;
  const res = await dbClient.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (res.rows.length === 0) return null;
  const file = res.rows[0];
  const newId = generateId(16);
  let storageName = null;
  let newPath = null;

  // Fetch custom drive settings if not provided (for backward compatibility and first call)
  const driveSettings = customDrive || (await getUserCustomDrive(userId));

  if (file.type === 'file') {
    // Get source file path (handles both relative and absolute)
    const sourcePath = resolveFilePath(file.path);

    if (driveSettings.enabled && driveSettings.path) {
      // If custom drive is enabled, copy to custom drive with original name
      try {
        const folderPath = await getFolderPath(parentId, userId);
        const destDir = folderPath || driveSettings.path;

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

        const insertResult = await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING modified',
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
            file.modified,
          ]
        );

        // Explicitly compare and update modified timestamp if the database overrode it (e.g., via trigger)
        const insertedModified = insertResult.rows[0].modified;
        const originalModified = new Date(file.modified);
        const actualModified = new Date(insertedModified);

        if (Math.abs(originalModified.getTime() - actualModified.getTime()) > 1000) {
          logger.warn(
            {
              fileId: newId,
              originalModified: originalModified.toISOString(),
              actualModified: actualModified.toISOString(),
            },
            'Modified timestamp was updated by DB on copy, explicitly setting to original (custom drive file in copyEntry)'
          );
          await dbClient.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
        }
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

      const insertResult = await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING modified',
        [
          newId,
          file.name,
          file.type,
          file.size,
          file.mime_type,
          newPath,
          parentId,
          userId,
          file.starred,
          file.shared,
          file.modified,
        ]
      );

      // Explicitly compare and update modified timestamp if the database overrode it (e.g., via trigger)
      const insertedModified = insertResult.rows[0].modified;
      const originalModified = new Date(file.modified);
      const actualModified = new Date(insertedModified);

      if (Math.abs(originalModified.getTime() - actualModified.getTime()) > 1000) {
        logger.warn(
          {
            fileId: newId,
            originalModified: originalModified.toISOString(),
            actualModified: actualModified.toISOString(),
          },
          'Modified timestamp was updated by DB on copy, explicitly setting to original (non-custom drive file in copyEntry)'
        );
        await dbClient.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
      }
    }
  } else if (file.type === 'folder') {
    // For folders created in custom drive, we need to create them on disk
    if (driveSettings.enabled && driveSettings.path) {
      let finalPath = null; // Declare outside try block to safely access in catch
      try {
        const parentPath = await getFolderPath(parentId, userId);
        const folderPath = parentPath ? path.join(parentPath, file.name) : path.join(driveSettings.path, file.name);

        // Handle duplicate folder names using utility function (via agent)
        finalPath = await getUniqueFolderPath(folderPath, true); // Use agent API
        const { agentMkdir } = require('../../utils/agentFileOperations');
        await agentMkdir(finalPath);
        const actualName = path.basename(finalPath);
        newPath = path.resolve(finalPath);

        const insertResult = await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING modified',
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
            file.modified,
          ]
        );

        // Explicitly compare and update modified timestamp if the database overrode it (e.g., via trigger)
        const insertedModified = insertResult.rows[0].modified;
        const originalModified = new Date(file.modified);
        const actualModified = new Date(insertedModified);

        if (Math.abs(originalModified.getTime() - actualModified.getTime()) > 1000) {
          logger.warn(
            {
              fileId: newId,
              originalModified: originalModified.toISOString(),
              actualModified: actualModified.toISOString(),
            },
            'Modified timestamp was updated by DB on copy, explicitly setting to original (custom drive folder in copyEntry)'
          );
          await dbClient.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
        }
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
      const insertResult = await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING modified',
        [
          newId,
          file.name,
          file.type,
          file.size,
          file.mime_type,
          null,
          parentId,
          userId,
          file.starred,
          file.shared,
          file.modified,
        ]
      );

      // Explicitly compare and update modified timestamp if the database overrode it (e.g., via trigger)
      const insertedModified = insertResult.rows[0].modified;
      const originalModified = new Date(file.modified);
      const actualModified = new Date(insertedModified);

      if (Math.abs(originalModified.getTime() - actualModified.getTime()) > 1000) {
        logger.warn(
          {
            fileId: newId,
            originalModified: originalModified.toISOString(),
            actualModified: actualModified.toISOString(),
          },
          'Modified timestamp was updated by DB on copy, explicitly setting to original (non-custom drive folder)'
        );
        await dbClient.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
      }
    }

    // Recursively copy folder contents (pass driveSettings to avoid redundant queries)
    const children = await dbClient.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [id, userId]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId, client, driveSettings);
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

    // Fetch custom drive settings once (won't change during copy operation)
    const customDrive = await getUserCustomDrive(userId);

    // Bulk fetch all root files in a single query (optimization)
    const rootFilesResult = await client.query('SELECT * FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [
      ids,
      userId,
    ]);
    const rootFilesMap = new Map(rootFilesResult.rows.map(f => [f.id, f]));

    // Process each root file (files are already fetched, so copyEntry can use them)
    for (const id of ids) {
      const file = rootFilesMap.get(id);
      if (file) {
        await copyEntryWithFile(file, parentId, userId, client, customDrive);
      }
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

/**
 * Copy entry with pre-fetched file data (optimized version)
 */
async function copyEntryWithFile(file, parentId, userId, client, customDrive) {
  const newId = generateId(16);
  let storageName = null;
  let newPath = null;

  if (file.type === 'file') {
    // Get source file path (handles both relative and absolute)
    const sourcePath = resolveFilePath(file.path);

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

        const insertResult = await client.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING modified',
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
            file.modified,
          ]
        );

        // Explicitly compare and update modified timestamp if the database overrode it (e.g., via trigger)
        const insertedModified = insertResult.rows[0].modified;
        // Convert both to Date objects for accurate comparison, or assume they are already Date objects
        const originalModified = new Date(file.modified);
        const actualModified = new Date(insertedModified);

        // Compare timestamps with a small tolerance for potential floating point differences
        // For accurate comparison, truncate to seconds or milliseconds before comparing
        if (Math.abs(originalModified.getTime() - actualModified.getTime()) > 1000) {
          logger.warn(
            {
              fileId: newId,
              originalModified: originalModified.toISOString(),
              actualModified: actualModified.toISOString(),
            },
            'Modified timestamp was updated by DB on copy, explicitly setting to original'
          );
          await client.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
        }
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

      // Get a unique display name for the file in the database
      const uniqueDisplayName = await getUniqueDbFileName(file.name, parentId, userId);

      const insertResult = await client.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING modified',
        [
          newId,
          uniqueDisplayName,
          file.type,
          file.size,
          file.mime_type,
          newPath,
          parentId,
          userId,
          file.starred,
          file.shared,
          file.modified,
        ]
      );

      // Explicitly compare and update modified timestamp if the database overrode it (e.g., via trigger)
      const insertedModified = insertResult.rows[0].modified;
      const originalModified = new Date(file.modified);
      const actualModified = new Date(insertedModified);

      if (Math.abs(originalModified.getTime() - actualModified.getTime()) > 1000) {
        logger.warn(
          {
            fileId: newId,
            originalModified: originalModified.toISOString(),
            actualModified: actualModified.toISOString(),
          },
          'Modified timestamp was updated by DB on copy, explicitly setting to original (non-custom drive file)'
        );
        await client.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
      }
    }
  } else if (file.type === 'folder') {
    // For folders created in custom drive, we need to create them on disk
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

        const insertResult = await client.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING modified',
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
            file.modified,
          ]
        );

        // Explicitly compare and update modified timestamp if the database overrode it (e.g., via trigger)
        const insertedModified = insertResult.rows[0].modified;
        const originalModified = new Date(file.modified);
        const actualModified = new Date(insertedModified);

        if (Math.abs(originalModified.getTime() - actualModified.getTime()) > 1000) {
          logger.warn(
            {
              fileId: newId,
              originalModified: originalModified.toISOString(),
              actualModified: actualModified.toISOString(),
            },
            'Modified timestamp was updated by DB on copy, explicitly setting to original (custom drive folder)'
          );
          await client.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
        }
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
      await client.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          newId,
          file.name,
          file.type,
          file.size,
          file.mime_type,
          null,
          parentId,
          userId,
          file.starred,
          file.shared,
          file.modified,
        ]
      );
    }

    // Recursively copy folder contents (pass customDrive to avoid redundant queries)
    const children = await client.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [
      file.id,
      userId,
    ]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId, client, customDrive);
    }
  }
  return newId;
}

module.exports = {
  moveFiles,
  copyFiles,
};
