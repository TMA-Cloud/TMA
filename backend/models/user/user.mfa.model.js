const pool = require('../../config/db');
const { logger } = require('../../config/logger');
const { deleteCache, cacheKeys } = require('../../utils/cache');

/**
 * Get user's MFA status
 * @param {string} userId - User ID
 * @returns {Promise<{enabled: boolean, secret: string|null}>}
 */
async function getMfaStatus(userId) {
  const result = await pool.query('SELECT mfa_enabled, mfa_secret FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) {
    return null;
  }
  return {
    enabled: result.rows[0].mfa_enabled || false,
    secret: result.rows[0].mfa_secret || null,
  };
}

/**
 * Set MFA secret (for setup, before verification)
 * @param {string} userId - User ID
 * @param {string} secret - TOTP secret
 * @param {boolean} enabled - Whether to enable MFA immediately
 * @returns {Promise<void>}
 */
async function setMfaSecret(userId, secret, enabled = false) {
  await pool.query('UPDATE users SET mfa_secret = $1, mfa_enabled = $2 WHERE id = $3', [secret, enabled, userId]);

  // Invalidate user cache
  await deleteCache(cacheKeys.userById(userId));
  if (enabled) {
    logger.info({ userId }, 'MFA enabled for user');
  } else {
    logger.info({ userId }, 'MFA secret stored (pending verification)');
  }
}

/**
 * Enable MFA for a user (assumes secret is already set)
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function enableMfa(userId) {
  await pool.query('UPDATE users SET mfa_enabled = TRUE WHERE id = $1', [userId]);

  // Invalidate user cache
  await deleteCache(cacheKeys.userById(userId));
  logger.info({ userId }, 'MFA enabled for user');
}

/**
 * Disable MFA for a user
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function disableMfa(userId) {
  await pool.query('UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL WHERE id = $1', [userId]);

  // Invalidate user cache
  await deleteCache(cacheKeys.userById(userId));
  logger.info({ userId }, 'MFA disabled for user');
}

/**
 * Get MFA secret for a user (for verification during setup)
 * @param {string} userId - User ID
 * @returns {Promise<string|null>}
 */
async function getMfaSecret(userId) {
  const result = await pool.query('SELECT mfa_secret FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.mfa_secret || null;
}

module.exports = {
  getMfaStatus,
  setMfaSecret,
  enableMfa,
  disableMfa,
  getMfaSecret,
};
