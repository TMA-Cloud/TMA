const pool = require('../../config/db');
const { logger } = require('../../config/logger');
const { getCache, setCache, deleteCache, cacheKeys, DEFAULT_TTL } = require('../../utils/cache');

async function isFirstUser(userId) {
  // Use stored first_user_id as source of truth (immutable, cannot be manipulated)
  const result = await pool.query('SELECT first_user_id FROM app_settings WHERE id = $1', ['app_settings']);

  if (result.rows.length === 0 || !result.rows[0].first_user_id) {
    // If no first user is set, check if this is the first user by created_at
    // This handles the case where migration runs before first user is created
    const firstUserResult = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    if (firstUserResult.rows.length === 0) {
      return false; // No users exist
    }
    const isFirst = firstUserResult.rows[0].id === userId;

    // If this is the first user and not yet stored, store it (one-time operation)
    if (isFirst) {
      try {
        await pool.query('UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL', [
          userId,
          'app_settings',
        ]);
      } catch (err) {
        // Ignore if another request already set it (race condition handled)
        logger.warn('Could not set first_user_id (may already be set):', err.message);
      }
    }
    return isFirst;
  }

  // Compare with stored first_user_id (immutable source of truth)
  return result.rows[0].first_user_id === userId;
}

async function getSignupEnabled() {
  // Try to get from cache first
  const cacheKey = cacheKeys.signupEnabled();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT signup_enabled FROM app_settings WHERE id = $1', ['app_settings']);
  let signupEnabled;
  if (result.rows.length === 0) {
    // If settings don't exist, check if any users exist
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count, 10);
    // If no users exist, signup should be enabled
    signupEnabled = userCount === 0;
  } else {
    signupEnabled = result.rows[0].signup_enabled;
  }

  // Cache the result (5 minutes TTL - changes infrequently)
  await setCache(cacheKey, signupEnabled, DEFAULT_TTL);

  return signupEnabled;
}

async function getTotalUserCount() {
  // Try to get from cache first
  const cacheKey = cacheKeys.userCount();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT COUNT(*) AS count FROM users');
  const count = Number(result.rows[0]?.count || 0);

  // Cache the result (5 minutes TTL)
  await setCache(cacheKey, count, DEFAULT_TTL);

  return count;
}

async function getAllUsersBasic() {
  // Try to get from cache first (without emails for security)
  const cacheKey = cacheKeys.allUsers();
  const cached = await getCache(cacheKey);

  if (cached !== null) {
    // Cache hit - fetch emails separately from database (emails not cached for security)
    // This gives us cache performance while protecting sensitive email data
    const emailResult = await pool.query('SELECT id, email FROM users ORDER BY created_at ASC');
    const emailMap = new Map(emailResult.rows.map(row => [row.id, row.email]));

    // Merge cached data with fresh emails
    return cached.map(user => ({
      ...user,
      email: emailMap.get(user.id) || null,
    }));
  }

  // Cache miss - query database
  const result = await pool.query('SELECT id, email, name, created_at FROM users ORDER BY created_at ASC');
  const users = result.rows;

  // Cache users WITHOUT emails for security (emails are sensitive PII)
  // If Redis is compromised, attackers won't get a clean email dump
  const usersWithoutEmails = users.map(user => ({
    id: user.id,
    name: user.name,
    created_at: user.created_at,
  }));
  await setCache(cacheKey, usersWithoutEmails, 120);

  // Return full data with emails (from database, not cache)
  return users;
}

async function setSignupEnabled(enabled, userId) {
  // Use transaction to ensure atomicity and verify user is first user
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify user is the first user using stored first_user_id
    const settingsResult = await client.query('SELECT first_user_id FROM app_settings WHERE id = $1', ['app_settings']);

    if (settingsResult.rows.length === 0) {
      throw new Error('App settings not found');
    }

    const storedFirstUserId = settingsResult.rows[0].first_user_id;

    // If first_user_id is not set yet, set it now (should only happen once)
    if (!storedFirstUserId) {
      // Get the actual first user
      const firstUserResult = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1 FOR UPDATE');

      if (firstUserResult.rows.length === 0) {
        throw new Error('No users exist');
      }

      const actualFirstUserId = firstUserResult.rows[0].id;

      // Only allow if the requesting user is the actual first user
      if (actualFirstUserId !== userId) {
        await client.query('ROLLBACK');
        throw new Error('Only the first user can toggle signup');
      }

      // Set the first_user_id (immutable after this point)
      await client.query('UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL', [
        actualFirstUserId,
        'app_settings',
      ]);
    } else if (storedFirstUserId !== userId) {
      // Verify the requesting user matches the stored first user ID
      await client.query('ROLLBACK');
      throw new Error('Only the first user can toggle signup');
    }

    // Update signup enabled status
    await client.query('UPDATE app_settings SET signup_enabled = $1, updated_at = NOW() WHERE id = $2', [
      enabled,
      'app_settings',
    ]);

    await client.query('COMMIT');

    // Invalidate signup enabled cache
    await deleteCache(cacheKeys.signupEnabled());

    // Log security event
    logger.info(`[SECURITY] Signup ${enabled ? 'enabled' : 'disabled'} by first user (ID: ${userId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
};
