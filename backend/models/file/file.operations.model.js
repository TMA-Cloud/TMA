const pool = require('../../config/db');

const path = require('path');
const { safeUnlink } = require('../../utils/fileCleanup');
const { generateId } = require('../../utils/id');
const { UPLOAD_DIR } = require('../../config/paths');
const { resolveFilePath, isFilePathEncrypted } = require('../../utils/filePath');
const { logger } = require('../../config/logger');
const { invalidateFileCache, invalidateSearchCache, deleteCache, cacheKeys } = require('../../utils/cache');

const { getUniqueDbFileName } = require('./file.utils.model');
const { copyEncryptedFile } = require('../../utils/fileEncryption');

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

    // Bulk update all files (DB-only move; all paths are relative to UPLOAD_DIR)
    const allIds = ids;
    const allNewPaths = allIds.map(() => null);

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
        'Modified timestamp was updated by DB on copy, explicitly setting to original'
      );
      await dbClient.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
    }
  } else if (file.type === 'folder') {
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
        'Modified timestamp was updated by DB on copy, explicitly setting to original'
      );
      await dbClient.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
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
        await copyEntryWithFile(file, parentId, userId, client);
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
async function copyEntryWithFile(file, parentId, userId, client) {
  const newId = generateId(16);
  let storageName = null;
  let newPath = null;

  if (file.type === 'file') {
    // Get source file path (handles both relative and absolute)
    const sourcePath = resolveFilePath(file.path);

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
        'Modified timestamp was updated by DB on copy, explicitly setting to original'
      );
      await client.query('UPDATE files SET modified = $1 WHERE id = $2', [originalModified, newId]);
    }
  } else if (file.type === 'folder') {
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

    // Recursively copy folder contents
    const children = await client.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [
      file.id,
      userId,
    ]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId, client);
    }
  }
  return newId;
}

module.exports = {
  moveFiles,
  copyFiles,
};
