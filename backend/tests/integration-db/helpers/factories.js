/**
 * Fixture builders for the integration suite.
 *
 * These write through the real models wherever one exists, so a test sets up
 * its world the same way the application would.
 */

import bcrypt from 'bcryptjs';

import pool from '../../../config/db.js';
import { createSubUser as createSubUserModel, createUser } from '../../../models/user.model.js';
import { generateId } from '../../../utils/id.js';

let sequence = 0;
const unique = () => `${Date.now().toString(36)}${(sequence++).toString(36)}`;

/**
 * Create a top-level account.
 * @param {Object} [overrides] - email, password, name
 * @returns {Promise<{id, email, name, password}>} `password` is the plaintext, for login tests.
 */
async function makeOwner({ email, password = 'correct-horse', name = 'Owner' } = {}) {
  const address = email || `owner-${unique()}@example.com`;
  const user = await createUser(address, await bcrypt.hash(password, 4), name);
  return { ...user, password };
}

/**
 * Create a sub-user under an owner.
 * @param {string} ownerId
 * @param {string[]} permissions - Capability keys to grant
 */
async function makeSubUser(ownerId, permissions = [], { email, password = 'correct-horse', name = 'Member' } = {}) {
  const address = email || `sub-${unique()}@example.com`;
  const subUser = await createSubUserModel({
    ownerId,
    email: address,
    hashedPassword: await bcrypt.hash(password, 4),
    name,
    permissions,
  });
  return { ...subUser, password };
}

/**
 * Insert a folder row directly.
 * @param {string} userId - Owning account
 * @param {Object} [opts] - name, parentId
 */
async function makeFolder(userId, { name = `Folder ${unique()}`, parentId = null } = {}) {
  const id = generateId(16);
  const { rows } = await pool.query(
    `INSERT INTO files (id, name, type, parent_id, user_id, size, modified)
     VALUES ($1, $2, 'folder', $3, $4, 0, NOW())
     RETURNING *`,
    [id, name, parentId, userId]
  );
  return rows[0];
}

/**
 * Insert a file row directly. Does not write bytes to storage — use
 * `makeStoredFile` when the test needs the object to exist.
 */
async function makeFile(
  userId,
  { name = `file-${unique()}.txt`, parentId = null, size = 1024, mimeType = 'text/plain', storagePath } = {}
) {
  const id = generateId(16);
  const key = storagePath || `${id}.bin`;
  const { rows } = await pool.query(
    `INSERT INTO files (id, name, type, parent_id, user_id, size, path, mime_type, modified)
     VALUES ($1, $2, 'file', $3, $4, $5, $6, $7, NOW())
     RETURNING *`,
    [id, name, parentId, userId, size, key, mimeType]
  );
  return rows[0];
}

/** Move a row to the trash, as the delete endpoint would. */
async function trashFile(fileId) {
  await pool.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fileId]);
}

/** Read a file row straight from the database. */
async function readFileRow(fileId) {
  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
  return rows[0];
}

/** Read a user row straight from the database. */
async function readUserRow(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0];
}

/** Count rows in a table, optionally filtered. */
async function countRows(table, where = '', params = []) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM "${table}" ${where}`, params);
  return rows[0].c;
}

export { makeOwner, makeSubUser, makeFolder, makeFile, trashFile, readFileRow, readUserRow, countRows, unique };
