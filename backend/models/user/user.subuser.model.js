/**
 * Sub-user model
 *
 * A sub-user is an extra login identity that belongs to a normal account. It
 * has its own email, password, MFA and sessions, but every file, folder and
 * byte of quota belongs to the *owner*. That boundary is expressed by
 * `users.parent_user_id`, and the effective account for any identity is
 * `COALESCE(parent_user_id, id)`.
 *
 * What a sub-user may do is an explicit set of grants (see utils/permissions.js)
 * rather than a coarse role, so an owner can allow downloading without
 * deleting, uploading without sharing, and so on.
 *
 * Sub-users cannot own sub-users. A database trigger enforces it, and
 * `createSubUser` refuses up front so the caller gets a useful error instead of
 * a constraint violation.
 */

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';

import { generateId } from '../../utils/id.js';
import { normalizePermissions, arePermissionsValid } from '../../utils/permissions.js';
import {
  deleteCache,
  invalidateEmailCache,
  invalidateUserCache,
  getCache,
  setCache,
  cacheKeys,
  DEFAULT_TTL,
} from '../../utils/cache.js';

/**
 * Resolve the account a login identity acts under.
 *
 * @param {string} userId - Authenticated user ID
 * @returns {Promise<{id: string, ownerId: string, permissions: string[], isSubUser: boolean}|null>}
 *          Account context, or null when the user does not exist.
 */
async function getAccountContext(userId) {
  const cacheKey = cacheKeys.userAccount(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT id, parent_user_id, permissions FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const isSubUser = Boolean(row.parent_user_id);
  const context = {
    id: row.id,
    ownerId: row.parent_user_id || row.id,
    // Owners are never checked against this list, so leaving it empty for them
    // keeps "who is allowed what" in exactly one place: hasPermission().
    permissions: isSubUser ? normalizePermissions(row.permissions) : [],
    isSubUser,
  };

  await setCache(cacheKey, context, DEFAULT_TTL * 2); // 10 minutes

  return context;
}

/**
 * List the sub-users belonging to an owner.
 * @param {string} ownerId - Owner user ID
 * @returns {Promise<Array<Object>>} Sub-users ordered by creation time
 */
async function listSubUsers(ownerId) {
  const result = await pool.query(
    `SELECT id, email, name, permissions, created_at, mfa_enabled
       FROM users
      WHERE parent_user_id = $1
      ORDER BY created_at ASC`,
    [ownerId]
  );
  return result.rows;
}

/**
 * Fetch a single sub-user, scoped to its owner so one account can never read
 * or mutate another account's members.
 * @param {string} ownerId - Owner user ID
 * @param {string} subUserId - Sub-user ID
 * @returns {Promise<Object|undefined>}
 */
async function getSubUser(ownerId, subUserId) {
  const result = await pool.query(
    `SELECT id, email, name, permissions, created_at, mfa_enabled
       FROM users
      WHERE id = $1 AND parent_user_id = $2`,
    [subUserId, ownerId]
  );
  return result.rows[0];
}

/**
 * Create a sub-user under an owner.
 *
 * @param {Object} params
 * @param {string} params.ownerId - Owner user ID (must be a top-level account)
 * @param {string} params.email - Sub-user login email
 * @param {string} params.hashedPassword - Already-hashed password
 * @param {string} params.name - Display name
 * @param {string[]} params.permissions - Capabilities to grant
 * @returns {Promise<Object>} The created sub-user
 * @throws {Error} When the parent is itself a sub-user, the name is missing, or a permission is unknown
 */
async function createSubUser({ ownerId, email, hashedPassword, name, permissions }) {
  if (!arePermissionsValid(permissions)) {
    throw new Error('Invalid sub-user permissions');
  }
  const grants = normalizePermissions(permissions);

  const displayName = typeof name === 'string' ? name.trim() : '';
  if (!displayName) {
    throw new Error('Sub-user name is required');
  }

  const id = generateId(16);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the parent row so a concurrent request cannot turn it into a
    // sub-user between this check and the insert.
    const parent = await client.query('SELECT id, parent_user_id FROM users WHERE id = $1 FOR UPDATE', [ownerId]);
    if (parent.rows.length === 0) {
      throw new Error('Owner account not found');
    }
    if (parent.rows[0].parent_user_id) {
      throw new Error('Sub-users cannot create sub-users');
    }

    const result = await client.query(
      `INSERT INTO users(id, email, password, name, parent_user_id, permissions)
       VALUES($1, $2, $3, $4, $5, $6)
       RETURNING id, email, name, permissions, created_at, mfa_enabled`,
      [id, email, hashedPassword, displayName, ownerId, grants]
    );

    await client.query('COMMIT');

    const subUser = result.rows[0];

    await deleteCache(cacheKeys.subUsers(ownerId));
    await deleteCache(cacheKeys.userCount());
    await deleteCache(cacheKeys.allUsers());
    await deleteCache(cacheKeys.signupEnabled());

    logger.info({ ownerId, subUserId: subUser.id, permissions: grants }, 'Sub-user created');

    return subUser;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Replace a sub-user's granted permissions.
 * @param {string} ownerId - Owner user ID
 * @param {string} subUserId - Sub-user ID
 * @param {string[]} permissions - The complete new set of grants
 * @returns {Promise<Object|undefined>} Updated sub-user, or undefined if not found
 */
async function updateSubUserPermissions(ownerId, subUserId, permissions) {
  if (!arePermissionsValid(permissions)) {
    throw new Error('Invalid sub-user permissions');
  }
  const grants = normalizePermissions(permissions);

  const result = await pool.query(
    `UPDATE users SET permissions = $1
      WHERE id = $2 AND parent_user_id = $3
      RETURNING id, email, name, permissions, created_at, mfa_enabled`,
    [grants, subUserId, ownerId]
  );

  const updated = result.rows[0];
  if (updated) {
    // The cached account context carries the grants, so it must go — otherwise
    // a revoked capability would keep working until the cache expired.
    await deleteCache(cacheKeys.userAccount(subUserId));
    await deleteCache(cacheKeys.subUsers(ownerId));
    logger.info({ ownerId, subUserId, permissions: grants }, 'Sub-user permissions updated');
  }

  return updated;
}

/**
 * Delete a sub-user. Files stay with the owner because they were always
 * stored under the owner's ID; only the login identity goes away.
 * @param {string} ownerId - Owner user ID
 * @param {string} subUserId - Sub-user ID
 * @returns {Promise<Object|undefined>} The deleted sub-user, or undefined if not found
 */
async function deleteSubUser(ownerId, subUserId) {
  const result = await pool.query(
    `DELETE FROM users
      WHERE id = $1 AND parent_user_id = $2
      RETURNING id, email, name, permissions`,
    [subUserId, ownerId]
  );

  const deleted = result.rows[0];
  if (deleted) {
    await invalidateUserCache(subUserId);
    await invalidateEmailCache(deleted.email);
    await deleteCache(cacheKeys.subUsers(ownerId));
    await deleteCache(cacheKeys.userCount());
    await deleteCache(cacheKeys.allUsers());
    logger.info({ ownerId, subUserId }, 'Sub-user deleted');
  }

  return deleted;
}

/**
 * Count an owner's sub-users.
 * @param {string} ownerId - Owner user ID
 * @returns {Promise<number>}
 */
async function countSubUsers(ownerId) {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE parent_user_id = $1', [ownerId]);
  return result.rows[0]?.count || 0;
}

export {
  getAccountContext,
  listSubUsers,
  getSubUser,
  createSubUser,
  updateSubUserPermissions,
  deleteSubUser,
  countSubUsers,
};
