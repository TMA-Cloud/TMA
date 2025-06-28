const pool = require('../config/db');
const { generateId } = require('../utils/id');

async function createShareLink(fileId, userId) {
  const id = generateId(8);
  await pool.query(
    'INSERT INTO share_links(id, file_id, user_id) VALUES($1,$2,$3)',
    [id, fileId, userId]
  );
  return id;
}

async function getShareLink(fileId, userId) {
  const res = await pool.query(
    'SELECT id FROM share_links WHERE file_id = $1 AND user_id = $2',
    [fileId, userId]
  );
  return res.rows[0]?.id || null;
}

async function deleteShareLink(fileId, userId) {
  await pool.query('DELETE FROM share_links WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
}

async function getFileByToken(token) {
  const res = await pool.query(
    `SELECT f.id, f.name, f.mime_type AS "mimeType", f.path
     FROM share_links s
     JOIN files f ON s.file_id = f.id
     WHERE s.id = $1`,
    [token]
  );
  return res.rows[0] || null;
}

module.exports = {
  createShareLink,
  getShareLink,
  deleteShareLink,
  getFileByToken,
};
