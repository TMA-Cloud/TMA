const pool = require('../config/db');
const { generateId } = require('../utils/id');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');

const SORT_FIELDS = {
  name: 'name',
  size: 'size',
  modified: 'modified',
  deletedAt: 'deleted_at',
};

function buildOrderClause(sortBy = 'modified', order = 'DESC') {
  const field = SORT_FIELDS[sortBy] || 'modified';
  const dir = order && order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  // When sorting by size we will compute folder sizes dynamically. However,
  // keep NULL values (shouldn't exist after computing) last just in case.
  const nulls = field === 'size' ? ' NULLS LAST' : '';
  return `ORDER BY ${field} ${dir}${nulls}`;
}

async function calculateFolderSize(id, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, size, type FROM files WHERE id = $1 AND user_id = $2
       UNION ALL
       SELECT f.id, f.size, f.type FROM files f
       JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2
     )
     SELECT COALESCE(SUM(size), 0) AS size FROM sub WHERE type = 'file'`,
    [id, userId],
  );
  return parseInt(res.rows[0].size, 10) || 0;
}

async function fillFolderSizes(files, userId) {
  await Promise.all(
    files.map(async (f) => {
      if (f.type === 'folder') {
        f.size = await calculateFolderSize(f.id, userId);
      }
    }),
  );
  return files;
}

async function getFiles(userId, parentId = null, sortBy = 'modified', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared
     FROM files
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}
     ${orderClause}`,
    parentId ? [userId, parentId] : [userId]
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

async function createFolder(name, parentId = null, userId) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO files(id, name, type, parent_id, user_id) VALUES($1,$2,$3,$4,$5) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'folder', parentId, userId]
  );
  return result.rows[0];
}

async function createFile(name, size, mimeType, tempPath, parentId = null, userId) {
  const id = generateId(16);
  const ext = path.extname(name);
  const storageName = id + ext;
  const dest = path.join(UPLOAD_DIR, storageName);
  await fs.promises.rename(tempPath, dest);
  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'file', size, mimeType, storageName, parentId, userId]
  );
  return result.rows[0];
}

async function moveFiles(ids, parentId = null, userId) {
  await pool.query(
    'UPDATE files SET parent_id = $1, modified = NOW() WHERE id = ANY($2::text[]) AND user_id = $3',
    [parentId, ids, userId],
  );
}

async function copyEntry(id, parentId, userId, client = null) {
  const dbClient = client || pool;
  const res = await dbClient.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (res.rows.length === 0) return null;
  const file = res.rows[0];
  const newId = generateId(16);
  let storageName = null;
  if (file.type === 'file') {
    const ext = path.extname(file.name);
    storageName = newId + ext;
    // Copy file first to ensure it exists before database entry
    try {
      await fs.promises.copyFile(
        path.join(UPLOAD_DIR, file.path),
        path.join(UPLOAD_DIR, storageName),
      );
    } catch (error) {
      console.error('Failed to copy file:', error);
      throw new Error('File copy operation failed');
    }
  }
  await dbClient.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      newId,
      file.name,
      file.type,
      file.size,
      file.mime_type,
      storageName,
      parentId,
      userId,
      file.starred,
      file.shared,
    ],
  );
  if (file.type === 'folder') {
    const children = await dbClient.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [id, userId]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId, client);
    }
  }
  return newId;
}

async function copyFiles(ids, parentId = null, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      await copyEntry(id, parentId, userId, client);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getFile(id, userId) {
  const result = await pool.query(
    'SELECT id, name, mime_type AS "mimeType", path FROM files WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0];
}

async function renameFile(id, name, userId) {
  const result = await pool.query(
    'UPDATE files SET name = $1, modified = NOW() WHERE id = $2 AND user_id = $3 RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [name, id, userId],
  );
  return result.rows[0];
}

async function setStarred(ids, starred, userId) {
  await pool.query(
    'UPDATE files SET starred = $1 WHERE id = ANY($2::text[]) AND user_id = $3',
    [starred, ids, userId],
  );
}

async function getRecursiveIds(ids, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM files WHERE id = ANY($1::text[]) AND user_id = $2
       UNION ALL
       SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2
     )
     SELECT id FROM sub`,
    [ids, userId],
  );
  return res.rows.map(r => r.id);
}

async function setShared(ids, shared, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return [];
  const res = await pool.query(
    'UPDATE files SET shared = $1 WHERE id = ANY($2::text[]) AND user_id = $3 RETURNING id',
    [shared, allIds, userId],
  );
  return res.rows.map(r => r.id);
}

async function deleteFiles(ids, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  await pool.query(
    'UPDATE files SET deleted_at = NOW() WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL',
    [allIds, userId],
  );
}

async function getTrashFiles(userId, sortBy = 'deletedAt', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const res = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared, deleted_at AS "deletedAt" FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL ${orderClause}`,
    [userId],
  );
  const files = res.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

async function permanentlyDeleteFiles(ids, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  const files = await pool.query(
    'SELECT id, path, type FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
    [allIds, userId],
  );
  for (const f of files.rows) {
    if (f.type === 'file' && f.path) {
      try {
        await fs.promises.unlink(path.join(UPLOAD_DIR, f.path));
      } catch {}
    }
  }
  await pool.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [allIds, userId]);
}

async function cleanupExpiredTrash() {
  const expired = await pool.query(
    "SELECT id, path, type FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'",
  );
  for (const f of expired.rows) {
    if (f.type === 'file' && f.path) {
      try {
        await fs.promises.unlink(path.join(UPLOAD_DIR, f.path));
      } catch {}
    }
  }
  await pool.query(
    "DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'",
  );
}

async function cleanupOrphanFiles() {
  const uploadsDir = UPLOAD_DIR;
  let diskFiles = [];
  try {
    diskFiles = await fs.promises.readdir(uploadsDir);
  } catch {
    diskFiles = [];
  }
  const diskSet = new Set(diskFiles);

  const dbRes = await pool.query(
    "SELECT id, path FROM files WHERE type = 'file'"
  );
  const dbSet = new Set();
  for (const row of dbRes.rows) {
    if (!row.path) continue;
    dbSet.add(row.path);
    if (!diskSet.has(row.path)) {
      await pool.query('DELETE FROM files WHERE id = $1', [row.id]);
    }
  }

  for (const file of diskFiles) {
    if (!dbSet.has(file)) {
      try {
        await fs.promises.unlink(path.join(uploadsDir, file));
      } catch {}
    }
  }
}

async function getStarredFiles(userId, sortBy = 'modified', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files WHERE user_id = $1 AND starred = TRUE ${orderClause}`,
    [userId],
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

async function getSharedFiles(userId, sortBy = 'modified', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files WHERE user_id = $1 AND shared = TRUE ${orderClause}`,
    [userId],
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

module.exports = {
  getFiles,
  createFolder,
  createFile,
  moveFiles,
  copyFiles,
  getFile,
  renameFile,
  setStarred,
  getStarredFiles,
  setShared,
  getRecursiveIds,
  getSharedFiles,
  deleteFiles,
  getTrashFiles,
  permanentlyDeleteFiles,
  cleanupExpiredTrash,
  cleanupOrphanFiles,
};
