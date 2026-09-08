import path from 'path';
import { PassThrough } from 'stream';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { invalidateAllFileCaches } from '../../utils/cache.js';
import { copyEncryptedFileStreams, getEncryptionKey, newWrappedDek, resolveIkm } from '../../utils/fileEncryption.js';
import { isFilePathEncrypted } from '../../utils/filePath.js';
import { generateId } from '../../utils/id.js';
import storage from '../../utils/storageDriver.js';

import { getUniqueDbFileName } from './file.utils.model.js';

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

    // Bulk update all files (DB-only move; object keys stay unchanged)
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

    // Invalidate cache for both old and new parent folders (move doesn't change total size)
    await invalidateAllFileCaches(userId, parentId, { includeStats: false, includeStorage: false });
    for (const oldParentId of oldParentIds) {
      if (oldParentId !== parentId) {
        await invalidateAllFileCaches(userId, oldParentId, {
          includeStats: false,
          includeStorage: false,
        });
      }
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Copy a single file or folder entry (recursive for folders).
 * Fetches the file from DB then delegates to copyEntryWithFile.
 */
async function copyEntry(id, parentId, userId, client = null) {
  const dbClient = client || pool;
  const res = await dbClient.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (res.rows.length === 0) return null;
  return copyEntryWithFile(res.rows[0], parentId, userId, dbClient);
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
    // Collect the new root-level IDs so the caller can reference them directly
    // instead of guessing via a name+type query (which is racy).
    const newRootIds = [];
    for (const id of ids) {
      const file = rootFilesMap.get(id);
      if (file) {
        const newId = await copyEntryWithFile(file, parentId, userId, client);
        newRootIds.push(newId);
      }
    }

    await client.query('COMMIT');

    // Invalidate cache after copying
    await invalidateAllFileCaches(userId, parentId);

    return newRootIds;
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
  let storageName;
  let newPath;

  if (file.type === 'file') {
    const ext = path.extname(file.name);
    storageName = newId + ext;
    const isSourceEncrypted = isFilePathEncrypted(file.path);

    // Decrypt the source under its own key; re-encrypt the copy under a fresh
    // DEK (envelope on) or the master key (off), so the copy is independently
    // keyed rather than sharing the source's key.
    const sourceIkm = isSourceEncrypted
      ? resolveIkm({ dekWrapped: file.dek_wrapped, dekKekVersion: file.dek_kek_version })
      : getEncryptionKey();
    const destDek = isSourceEncrypted ? newWrappedDek() : null;
    const destIkm = destDek ? destDek.dek : getEncryptionKey();

    try {
      const destKey = storageName;
      if (isSourceEncrypted) {
        const passThrough = new PassThrough();
        const uploadPromise = storage.putStream(destKey, passThrough);
        await copyEncryptedFileStreams(await storage.getReadStream(file.path), passThrough, sourceIkm, destIkm);
        await uploadPromise;
      } else {
        const stream = await storage.getReadStream(file.path);
        await storage.putStream(destKey, stream);
      }
    } catch (error) {
      logger.error('Failed to copy file:', error);

      throw new Error('File copy operation failed', { cause: error });
    }
    newPath = storageName;

    const uniqueDisplayName = await getUniqueDbFileName(file.name, parentId, userId);

    const insertResult = await client.query(
      'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified, dek_wrapped, dek_kek_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING modified',
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
        destDek ? destDek.dekWrapped : null,
        destDek ? destDek.kekVersion : null,
      ]
    );

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

export { moveFiles, copyFiles };
