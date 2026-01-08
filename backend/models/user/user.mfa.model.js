const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { logger } = require('../../config/logger');
const { deleteCache, cacheKeys } = require('../../utils/cache');
const { generateId } = require('../../utils/id');

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
  // Delete all backup codes when disabling MFA
  await deleteBackupCodes(userId);
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

/**
 * Generate backup codes for a user
 * @param {string} userId - User ID
 * @param {number} count - Number of codes to generate (default: 10)
 * @returns {Promise<string[]>} Array of plain text backup codes
 */
async function generateBackupCodes(userId, count = 10) {
  // Character set excluding ambiguous characters (0, O, 1, I, l)
  // Using uppercase letters and numbers for better readability
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codeLength = 8;

  // Generate all plain text codes first
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    // Generate cryptographically secure random codes
    const randomBytes = crypto.randomBytes(codeLength);
    for (let j = 0; j < codeLength; j++) {
      code += chars[randomBytes[j] % chars.length];
    }
    codes.push(code);
  }

  // Hash all codes in parallel for better performance
  const hashPromises = codes.map(code => bcrypt.hash(code, 10));
  const codeHashes = await Promise.all(hashPromises);

  // Store all hashed codes in database
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const hash of codeHashes) {
      const id = generateId(16);
      await client.query('INSERT INTO mfa_backup_codes(id, user_id, code_hash) VALUES($1, $2, $3)', [id, userId, hash]);
    }

    await client.query('COMMIT');
    logger.info({ userId, count }, 'Backup codes generated');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return codes;
}

/**
 * Verify and consume a backup code
 * @param {string} userId - User ID
 * @param {string} code - Backup code to verify
 * @returns {Promise<boolean>} True if code is valid and was consumed
 */
async function verifyAndConsumeBackupCode(userId, code) {
  if (!code || typeof code !== 'string') {
    return false;
  }

  // Get all unused backup codes for this user
  const result = await pool.query('SELECT id, code_hash FROM mfa_backup_codes WHERE user_id = $1 AND used = FALSE', [
    userId,
  ]);

  // Try to match the code against any unused backup code
  for (const row of result.rows) {
    const match = await bcrypt.compare(code, row.code_hash);
    if (match) {
      // Mark as used
      await pool.query('UPDATE mfa_backup_codes SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
      logger.info({ userId }, 'Backup code consumed');
      return true;
    }
  }

  return false;
}

/**
 * Get count of remaining unused backup codes
 * @param {string} userId - User ID
 * @returns {Promise<number>} Number of unused backup codes
 */
async function getRemainingBackupCodesCount(userId) {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM mfa_backup_codes WHERE user_id = $1 AND used = FALSE',
    [userId]
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Delete all backup codes for a user
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function deleteBackupCodes(userId) {
  await pool.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
  logger.info({ userId }, 'Backup codes deleted');
}

module.exports = {
  getMfaStatus,
  setMfaSecret,
  enableMfa,
  disableMfa,
  getMfaSecret,
  generateBackupCodes,
  verifyAndConsumeBackupCode,
  getRemainingBackupCodesCount,
  deleteBackupCodes,
};
