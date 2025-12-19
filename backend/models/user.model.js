const pool = require('../config/db');
const { generateId } = require('../utils/id');
const { logger } = require('../config/logger');

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

async function isFirstUser(userId) {
  // Use stored first_user_id as source of truth (immutable, cannot be manipulated)
  const result = await pool.query(
    'SELECT first_user_id FROM app_settings WHERE id = $1',
    ['app_settings']
  );
  
  if (result.rows.length === 0 || !result.rows[0].first_user_id) {
    // If no first user is set, check if this is the first user by created_at
    // This handles the case where migration runs before first user is created
    const firstUserResult = await pool.query(
      'SELECT id FROM users ORDER BY created_at ASC LIMIT 1'
    );
    if (firstUserResult.rows.length === 0) {
      return false; // No users exist
    }
    const isFirst = firstUserResult.rows[0].id === userId;
    
    // If this is the first user and not yet stored, store it (one-time operation)
    if (isFirst) {
      try {
        await pool.query(
          'UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL',
          [userId, 'app_settings']
        );
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
  const result = await pool.query(
    'SELECT signup_enabled FROM app_settings WHERE id = $1',
    ['app_settings']
  );
  if (result.rows.length === 0) {
    // If settings don't exist, check if any users exist
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count, 10);
    // If no users exist, signup should be enabled
    return userCount === 0;
  }
  return result.rows[0].signup_enabled;
}

async function getTotalUserCount() {
  const result = await pool.query('SELECT COUNT(*) AS count FROM users');
  return Number(result.rows[0]?.count || 0);
}

async function getAllUsersBasic() {
  const result = await pool.query(
    'SELECT id, email, name, created_at FROM users ORDER BY created_at ASC'
  );
  return result.rows;
}

async function setSignupEnabled(enabled, userId) {
  // Use transaction to ensure atomicity and verify user is first user
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Verify user is the first user using stored first_user_id
    const settingsResult = await client.query(
      'SELECT first_user_id FROM app_settings WHERE id = $1',
      ['app_settings']
    );
    
    if (settingsResult.rows.length === 0) {
      throw new Error('App settings not found');
    }
    
    const storedFirstUserId = settingsResult.rows[0].first_user_id;
    
    // If first_user_id is not set yet, set it now (should only happen once)
    if (!storedFirstUserId) {
      // Get the actual first user
      const firstUserResult = await client.query(
        'SELECT id FROM users ORDER BY created_at ASC LIMIT 1 FOR UPDATE'
      );
      
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
      await client.query(
        'UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL',
        [actualFirstUserId, 'app_settings']
      );
    } else {
      // Verify the requesting user matches the stored first user ID
      if (storedFirstUserId !== userId) {
        await client.query('ROLLBACK');
        throw new Error('Only the first user can toggle signup');
      }
    }
    
    // Update signup enabled status
    await client.query(
      'UPDATE app_settings SET signup_enabled = $1, updated_at = NOW() WHERE id = $2',
      [enabled, 'app_settings']
    );
    
    await client.query('COMMIT');
    
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
  createUser,
  getUserByEmail,
  getUserById,
  getUserStorageUsage,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId,
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic
};
