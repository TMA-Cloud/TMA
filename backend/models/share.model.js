const pool = require('../config/db');
const { generateId } = require('../utils/id');

async function createShareLink(fileId, userId, fileIds = [fileId]) {
  // Use 16-character tokens for ~93 bits of entropy (same as file IDs)
  // This makes brute-force attacks computationally infeasible
  const id = generateId(16);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO share_links(id, file_id, user_id) VALUES($1,$2,$3)', [id, fileId, userId]);
    await client.query('INSERT INTO share_link_files(share_id, file_id) SELECT $1, unnest($2::text[])', [id, fileIds]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return id;
}

async function getShareLink(fileId, userId) {
  const res = await pool.query('SELECT id FROM share_links WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
  return res.rows[0]?.id || null;
}

async function addFilesToShare(shareId, fileIds) {
  if (!fileIds || fileIds.length === 0) return;
  await pool.query(
    'INSERT INTO share_link_files(share_id, file_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
    [shareId, fileIds]
  );
}

async function removeFilesFromShares(fileIds, userId) {
  if (!fileIds || fileIds.length === 0) return;
  await pool.query(
    `DELETE FROM share_link_files
     WHERE file_id = ANY($1::text[])
       AND share_id IN (SELECT id FROM share_links WHERE user_id = $2)`,
    [fileIds, userId]
  );
}

async function deleteShareLink(fileId, userId) {
  await pool.query('DELETE FROM share_links WHERE file_id = $1 AND user_id = $2', [fileId, userId]);
}

async function getFileByToken(token) {
  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.path, f.user_id AS "userId"
     FROM share_links s
     JOIN files f ON s.file_id = f.id
     WHERE s.id = $1`,
    [token]
  );
  return res.rows[0] || null;
}

async function getFolderContents(folderId, userId) {
  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.size, f.path,
            sl.id AS token
     FROM files f
     LEFT JOIN share_links sl ON sl.file_id = f.id AND sl.user_id = $2
     WHERE f.parent_id = $1 AND f.user_id = $2 AND sl.id IS NOT NULL
     ORDER BY f.type DESC, f.name`,
    [folderId, userId]
  );
  return res.rows;
}

async function getFolderContentsByShare(token, folderId) {
  const res = await pool.query(
    `SELECT f.id, f.name, f.type, f.mime_type AS "mimeType", f.size, f.path
     FROM share_link_files s
     JOIN files f ON s.file_id = f.id
     WHERE s.share_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'}
     ORDER BY f.type DESC, f.name`,
    folderId ? [token, folderId] : [token]
  );
  return res.rows;
}

async function isFileShared(token, fileId) {
  const res = await pool.query('SELECT 1 FROM share_link_files WHERE share_id = $1 AND file_id = $2', [token, fileId]);
  return res.rowCount > 0;
}

async function getSharedTree(token, rootId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT f.* FROM files f
       JOIN share_link_files slf ON slf.file_id = f.id
       WHERE slf.share_id = $1 AND f.id = $2
       UNION ALL
       SELECT f.* FROM files f
       JOIN share_link_files slf ON slf.file_id = f.id
       JOIN sub s ON f.parent_id = s.id
       WHERE slf.share_id = $1
     )
     SELECT id, name, type, path, parent_id FROM sub`,
    [token, rootId]
  );
  return res.rows;
}

module.exports = {
  createShareLink,
  getShareLink,
  addFilesToShare,
  removeFilesFromShares,
  deleteShareLink,
  getFileByToken,
  getFolderContents,
  getFolderContentsByShare,
  isFileShared,
  getSharedTree,
};
