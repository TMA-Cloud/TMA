const pool = require('../config/db');
const { generateId } = require('../utils/id');

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

async function createFile(name, size, mimeType, parentId = null, userId) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'file', size, mimeType, parentId, userId]
  );
  return result.rows[0];
}

module.exports = { getFiles, createFolder, createFile };
