const pool = require('../../config/db');
const { generateId } = require('../../utils/id');
const { getCache, setCache, deleteCache, cacheKeys, DEFAULT_TTL } = require('../../utils/cache');

async function createUser(email, password, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, password, name) VALUES($1,$2,$3,$4) RETURNING id, email, name',
    [id, email, password, name]
  );

  // Cache the new user (without password for security)
  const user = result.rows[0];
  await setCache(
    cacheKeys.userById(id),
    { id: user.id, email: user.email, name: user.name, token_version: 0 },
    DEFAULT_TTL * 2
  );
  // Note: We don't cache userByEmail on creation to avoid caching password
  // The password will be cached on first lookup if needed, but we should avoid that too

  // Invalidate user count cache
  await deleteCache(cacheKeys.userCount());
  await deleteCache(cacheKeys.allUsers());
  await deleteCache(cacheKeys.signupEnabled());

  return user;
}

async function getUserByEmail(email) {
  // SECURITY: Do NOT cache getUserByEmail because it's used for authentication
  // and contains password hashes. Password hashes should never be cached.
  // Always query from database to ensure we have the latest password hash
  // and to avoid storing sensitive data in Redis.
  const result = await pool.query('SELECT id, email, password, name FROM users WHERE email = $1', [email]);
  return result.rows[0];
}

async function getUserById(id) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userById(id);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT id, email, name, token_version FROM users WHERE id = $1', [id]);
  const user = result.rows[0];

  // Cache the result (longer TTL for user data)
  if (user) {
    await setCache(cacheKey, user, DEFAULT_TTL * 2); // 10 minutes TTL
  }

  return user;
}

async function getUserByGoogleId(googleId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userByGoogleId(googleId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query('SELECT id, email, name, google_id FROM users WHERE google_id = $1', [googleId]);
  const user = res.rows[0];

  // Cache the result (10 minutes TTL)
  if (user) {
    await setCache(cacheKey, user, DEFAULT_TTL * 2);
  }

  return user;
}

async function createUserWithGoogle(googleId, email, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, name, google_id) VALUES($1,$2,$3,$4) RETURNING id, email, name, google_id',
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
    const { invalidateEmailCache } = require('../../utils/cache');
    await invalidateEmailCache(email);
  }
}

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId,
};
