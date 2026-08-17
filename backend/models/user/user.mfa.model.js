import crypto from 'crypto';

import bcrypt from 'bcryptjs';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { deleteCache, cacheKeys } from '../../utils/cache.js';
import { generateId } from '../../utils/id.js';

// Cooldown period for backup code regeneration (5 minutes in milliseconds)
const BACKUP_CODE_REGENERATION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Get user's MFA status
 * @param {string} userId - User ID
 * @returns {Promise<{enabled: boolean, secret: string|null}>}
 */
async function getMfaStatus(userId) {
  const result = await pool.query('SELECT mfa_enabled, mfa_secret, mfa_last_time_step FROM users WHERE id = $1', [
    userId,
  ]);
  if (result.rows.length === 0) {
    return null;
  }
  return {
    enabled: result.rows[0].mfa_enabled || false,
    secret: result.rows[0].mfa_secret || null,
    // BIGINT comes back as a string from pg; the caller compares it numerically.
    lastTimeStep: result.rows[0].mfa_last_time_step === null ? null : Number(result.rows[0].mfa_last_time_step),
  };
}

/**
 * Claim a TOTP time step, rejecting one already used.
 *
 * Single conditional UPDATE on purpose: a separate read then write would let
 * concurrent logins with the same stolen code all pass.
 *
 * @param {string} userId - User ID
 * @param {number} timeStep - Time step the presented code belongs to
 * @returns {Promise<boolean>} False if this step (or a later one) was already used
 */
async function consumeMfaTimeStep(userId, timeStep) {
  const result = await pool.query(
    `UPDATE users SET mfa_last_time_step = $2
     WHERE id = $1 AND (mfa_last_time_step IS NULL OR mfa_last_time_step < $2)`,
    [userId, timeStep]
  );
  return result.rowCount > 0;
}

/**
 * Set MFA secret (for setup, before verification)
 * @param {string} userId - User ID
 * @param {string} secret - TOTP secret
 * @param {boolean} enabled - Whether to enable MFA immediately
 * @returns {Promise<void>}
 */
async function setMfaSecret(userId, secret, enabled = false) {
  // Reset the replay counter: steps from the old secret mean nothing here, and
  // a leftover high value would reject valid codes.
  await pool.query('UPDATE users SET mfa_secret = $1, mfa_enabled = $2, mfa_last_time_step = NULL WHERE id = $3', [
    secret,
    enabled,
    userId,
  ]);

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
  await pool.query('UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_last_time_step = NULL WHERE id = $1', [
    userId,
  ]);

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
 * Mint plain codes and their hashes. No database access.
 *
 * Hashing stays outside the transaction below: ten bcrypt rounds take about a
 * second, which is a long time to hold a connection and the rows it locks.
 *
 * @param {number} count
 * @returns {Promise<{codes: string[], codeHashes: string[]}>}
 */
async function buildBackupCodes(count) {
  // Character set excluding ambiguous characters (0, O, 1, I, l)
  // Using uppercase letters and numbers for better readability
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codeLength = 8;

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
  const codeHashes = await Promise.all(codes.map(code => bcrypt.hash(code, 10)));
  return { codes, codeHashes };
}

/** Insert hashed codes using a caller-supplied client, inside its transaction. */
async function insertBackupCodes(client, userId, codeHashes) {
  for (const hash of codeHashes) {
    await client.query('INSERT INTO mfa_backup_codes(id, user_id, code_hash) VALUES($1, $2, $3)', [
      generateId(16),
      userId,
      hash,
    ]);
  }
}

/**
 * Run `work` in a transaction, rolling back if it throws.
 * @param {(client: import('pg').PoolClient) => Promise<void>} work
 */
async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Generate backup codes for a user
 * @param {string} userId - User ID
 * @param {number} count - Number of codes to generate (default: 10)
 * @returns {Promise<string[]>} Array of plain text backup codes
 */
async function generateBackupCodes(userId, count = 10) {
  const { codes, codeHashes } = await buildBackupCodes(count);

  await inTransaction(client => insertBackupCodes(client, userId, codeHashes));

  logger.info({ userId, count }, 'Backup codes generated');
  return codes;
}

/**
 * Swap a user's backup codes for a fresh set.
 *
 * Delete and insert share one transaction: if minting the replacements fails
 * partway, the user keeps the codes they had rather than being left with none.
 *
 * @param {string} userId - User ID
 * @param {number} count - Number of codes to generate (default: 10)
 * @returns {Promise<string[]>} Array of plain text backup codes
 */
async function replaceBackupCodes(userId, count = 10) {
  const { codes, codeHashes } = await buildBackupCodes(count);

  await inTransaction(async client => {
    await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
    await insertBackupCodes(client, userId, codeHashes);
  });

  logger.info({ userId, count }, 'Backup codes replaced');
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
      // Re-check `used` in the UPDATE itself: the row was read before the slow
      // bcrypt compare, so a concurrent login could have spent it since.
      const claimed = await pool.query(
        'UPDATE mfa_backup_codes SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = $1 AND used = FALSE',
        [row.id]
      );
      if (claimed.rowCount === 0) {
        logger.warn({ userId }, 'Rejected reuse of an already-consumed backup code');
        return false;
      }
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

/**
 * Check if backup code regeneration is allowed (cooldown check)
 * @param {string} userId - User ID
 * @returns {Promise<{allowed: boolean, remainingMs: number|null}>}
 */
async function canRegenerateBackupCodes(userId) {
  const result = await pool.query('SELECT last_backup_code_regeneration FROM users WHERE id = $1', [userId]);

  if (result.rows.length === 0) {
    return { allowed: false, remainingMs: null };
  }

  const lastRegeneration = result.rows[0].last_backup_code_regeneration;

  // If never regenerated, allow it
  if (!lastRegeneration) {
    return { allowed: true, remainingMs: 0 };
  }

  const now = new Date();
  const timeSinceLastRegeneration = now.getTime() - new Date(lastRegeneration).getTime();
  const remainingMs = BACKUP_CODE_REGENERATION_COOLDOWN_MS - timeSinceLastRegeneration;

  if (remainingMs > 0) {
    return { allowed: false, remainingMs };
  }

  return { allowed: true, remainingMs: 0 };
}

/**
 * Claim the regeneration cooldown, stamping it only if it has expired.
 *
 * Same reason as the other claims here: checking the cooldown and stamping it
 * separately lets concurrent requests both pass the check.
 *
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} False if the cooldown is still running
 */
async function claimBackupCodeRegeneration(userId) {
  const result = await pool.query(
    `UPDATE users SET last_backup_code_regeneration = CURRENT_TIMESTAMP
     WHERE id = $1 AND (last_backup_code_regeneration IS NULL
       OR last_backup_code_regeneration <= CURRENT_TIMESTAMP - make_interval(secs => $2))`,
    [userId, BACKUP_CODE_REGENERATION_COOLDOWN_MS / 1000]
  );

  // Invalidate user cache
  await deleteCache(cacheKeys.userById(userId));
  return result.rowCount > 0;
}

export {
  getMfaStatus,
  setMfaSecret,
  enableMfa,
  disableMfa,
  getMfaSecret,
  consumeMfaTimeStep,
  generateBackupCodes,
  replaceBackupCodes,
  verifyAndConsumeBackupCode,
  getRemainingBackupCodesCount,
  deleteBackupCodes,
  canRegenerateBackupCodes,
  claimBackupCodeRegeneration,
};
