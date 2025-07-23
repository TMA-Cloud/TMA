const pool = require('../config/db');
const { generateId } = require('../utils/id');

async function createUser(email, password, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, password, name) VALUES($1,$2,$3,$4) RETURNING id, email, name',
    [id, email, password, name]
  );
  return result.rows[0];
}

async function getUserByEmail(email) {
  const result = await pool.query(
    'SELECT id, email, password, name FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0];
}

async function getUserById(id) {
  const result = await pool.query(
    'SELECT id, email, name FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

async function getUserStorageUsage(userId) {
  const res = await pool.query(
    "SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = $1 AND type = 'file' AND deleted_at IS NULL",
    [userId]
  );
  return Number(res.rows[0].used) || 0;
}

async function getUserByGoogleId(googleId) {
  const res = await pool.query(
    'SELECT id, email, name, google_id FROM users WHERE google_id = $1',
    [googleId]
  );
  return res.rows[0];
}

async function createUserWithGoogle(googleId, email, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, name, google_id) VALUES($1,$2,$3,$4) RETURNING id, email, name, google_id',
    [id, email, name, googleId]
  );
  return result.rows[0];
}

async function updateGoogleId(userId, googleId) {
  await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, userId]);
}

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  getUserStorageUsage,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId
};
