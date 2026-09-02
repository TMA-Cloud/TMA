import pool from '../../config/db.js';

import { generateId } from '../../utils/id.js';
import { getCache, setCache, deleteCache, invalidateEmailCache, cacheKeys, DEFAULT_TTL } from '../../utils/cache.js';

async function createUser(email, password, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, password, name) VALUES($1,$2,$3,$4) RETURNING id, email, name, created_at, mfa_enabled',
    [id, email, password, name]
  );

  // Cache the new user (without password for security)
  const user = result.rows[0];
  await setCache(
    cacheKeys.userById(id),
    { id: user.id, email: user.email, name: user.name, token_version: 0 },
    DEFAULT_TTL * 2
  );
  // Don't cache userByEmail on creation — it would cache the password hash.

  await deleteCache(cacheKeys.userCount());
  await deleteCache(cacheKeys.allUsers());
  await deleteCache(cacheKeys.signupEnabled());

  return user;
}

async function getUserByEmail(email) {
  // SECURITY: never cache — this is the auth path and the row holds the password
  // hash. Always read from the DB.
  const result = await pool.query(
    'SELECT id, email, password, name, created_at, mfa_enabled FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0];
}

async function getUserById(id) {
  const cacheKey = cacheKeys.userById(id);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query(
    'SELECT id, email, name, token_version, created_at, mfa_enabled FROM users WHERE id = $1',
    [id]
  );
  const user = result.rows[0];

  if (user) {
    await setCache(cacheKey, user, DEFAULT_TTL * 2); // 10 minutes TTL
  }

  return user;
}

async function getUserByIdWithPassword(id) {
  const result = await pool.query('SELECT id, email, password, name, google_id FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

async function updateUserPassword(userId, hashedPassword) {
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
  await deleteCache(cacheKeys.userById(userId));
}

async function getUserByGoogleId(googleId) {
  const cacheKey = cacheKeys.userByGoogleId(googleId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const res = await pool.query('SELECT id, email, name, google_id FROM users WHERE google_id = $1', [googleId]);
  const user = res.rows[0];

  if (user) {
    await setCache(cacheKey, user, DEFAULT_TTL * 2);
  }

  return user;
}

async function createUserWithGoogle(googleId, email, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, name, google_id) VALUES($1,$2,$3,$4) RETURNING id, email, name, google_id, created_at, mfa_enabled',
    [id, email, name, googleId]
  );

  // Cache the new user
  const user = result.rows[0];
  await setCache(
    cacheKeys.userById(id),
    { id: user.id, email: user.email, name: user.name, token_version: 0 },
    DEFAULT_TTL * 2
  );
  await setCache(
    cacheKeys.userByEmail(email),
    { id: user.id, email: user.email, name: user.name, google_id: user.google_id },
    DEFAULT_TTL * 2
  );
  await setCache(cacheKeys.userByGoogleId(googleId), user, DEFAULT_TTL * 2);

  // Invalidate user count cache
  await deleteCache(cacheKeys.userCount());
  await deleteCache(cacheKeys.allUsers());
  await deleteCache(cacheKeys.signupEnabled());

  return user;
}

async function updateGoogleId(userId, googleId) {
  // Get user email before updating for cache invalidation
  const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = userResult.rows[0]?.email;

  await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, userId]);

  // Invalidate user cache
  await deleteCache(cacheKeys.userById(userId));
  // Invalidate email cache if email exists
  if (email) {
    await invalidateEmailCache(email);
  }
}

export {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByIdWithPassword,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId,
  updateUserPassword,
};
