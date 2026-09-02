import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';

/**
 * Verify the requesting user is the first user (admin) within a transaction.
 * Sets first_user_id atomically if not yet stored.
 * @param {import('pg').PoolClient} client - Active DB transaction client
 * @param {string} userId - Requesting user ID
 * @param {string} actionLabel - Human-readable action name for error messages
 */
async function verifyFirstUser(client, userId, actionLabel = 'perform this action') {
  const settingsResult = await client.query('SELECT first_user_id FROM app_settings WHERE id = $1', ['app_settings']);
  if (settingsResult.rows.length === 0) {
    throw new Error('App settings not found');
  }

  const storedFirstUserId = settingsResult.rows[0].first_user_id;

  if (!storedFirstUserId) {
    const firstUserResult = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1 FOR UPDATE');
    if (firstUserResult.rows.length === 0) {
      throw new Error('No users exist');
    }
    if (firstUserResult.rows[0].id !== userId) {
      throw new Error(`Only the first user can ${actionLabel}`);
    }
    await client.query('UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL', [
      firstUserResult.rows[0].id,
      'app_settings',
    ]);
  } else if (storedFirstUserId !== userId) {
    throw new Error(`Only the first user can ${actionLabel}`);
  }
}

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

export { verifyFirstUser, isFirstUser };
