const pool = require('../config/db');
const { generateId } = require('../utils/id');
const fs = require('fs');
const path = require('path');

async function getFiles(userId, parentId = null) {
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared
     FROM files
     WHERE user_id = $1 AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}
     ORDER BY modified DESC`,
    parentId ? [userId, parentId] : [userId]
  );
  return result.rows;
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
  const dest = path.join(__dirname, '..', 'uploads', storageName);
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

async function copyEntry(id, parentId, userId) {
  const res = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (res.rows.length === 0) return null;
  const file = res.rows[0];
  const newId = generateId(16);
  let storageName = null;
  if (file.type === 'file') {
    const ext = path.extname(file.name);
    storageName = newId + ext;
    await fs.promises.copyFile(
      path.join(__dirname, '..', 'uploads', file.path),
      path.join(__dirname, '..', 'uploads', storageName),
    );
  }
  await pool.query(
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
    const children = await pool.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [id, userId]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId);
    }
  }
  return newId;
}

async function copyFiles(ids, parentId = null, userId) {
  for (const id of ids) {
    await copyEntry(id, parentId, userId);
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

module.exports = {
  getFiles,
  createFolder,
  createFile,
  moveFiles,
  copyFiles,
  getFile,
  renameFile,
};
