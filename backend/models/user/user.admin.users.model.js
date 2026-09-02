import path from 'path';
import { fileURLToPath } from 'url';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { useS3 } from '../../config/storage.js';
import { getCache, setCache, deleteCache, cacheKeys, DEFAULT_TTL } from '../../utils/cache.js';
import { getActualDiskSize, formatFileSize } from '../../utils/storageUtils.js';
import { verifyFirstUser } from './user.admin.helpers.model.js';
import { setSignupEnabled } from './user.admin.settings.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function getTotalUserCount() {
  const cacheKey = cacheKeys.userCount();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT COUNT(*) AS count FROM users');
  const count = Number(result.rows[0]?.count || 0);

  await setCache(cacheKey, count, DEFAULT_TTL);

  return count;
}

async function getAllUsersBasic() {
  // Sub-users are grouped under their owner, and usage is aggregated per account
  // (a sub-user's uploads are stored against the owner) via one grouped subquery.
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.created_at, u.mfa_enabled, u.storage_limit,
            u.parent_user_id, u.permissions,
            COALESCE(acct_usage.used, 0) AS storage_used
       FROM users u
       LEFT JOIN (
         SELECT COALESCE(o.parent_user_id, o.id) AS account_id, SUM(f.size) AS used
           FROM files f
           JOIN users o ON o.id = f.user_id
          WHERE f.type = 'file'
          GROUP BY 1
       ) acct_usage ON acct_usage.account_id = COALESCE(u.parent_user_id, u.id)
      ORDER BY COALESCE(u.parent_user_id, u.id), u.parent_user_id NULLS FIRST, u.created_at ASC`
  );

  // Disk capacity is measured once (same for every account). On S3 there is no
  // disk cap — only an explicit limit applies, and its absence means unlimited.
  let diskSize = null;
  if (!useS3) {
    try {
      diskSize = await getActualDiskSize(process.env.UPLOAD_DIR || __dirname);
    } catch (err) {
      logger.warn({ err }, 'Could not determine disk size for user list');
    }
  }

  // A sub-user row reports its owner's capacity (the pool it draws from).
  const limitByAccount = new Map(
    result.rows
      .filter(row => !row.parent_user_id)
      .map(row => [row.id, row.storage_limit != null ? Number(row.storage_limit) : null])
  );

  return result.rows.map(row => {
    const accountId = row.parent_user_id || row.id;
    const limit = limitByAccount.has(accountId)
      ? limitByAccount.get(accountId)
      : row.storage_limit != null
        ? Number(row.storage_limit)
        : null;

    let storageTotal;
    if (diskSize != null) {
      storageTotal = Math.min(diskSize, limit ?? diskSize);
    } else {
      storageTotal = limit;
    }

    return {
      ...row,
      storage_used: Number(row.storage_used) || 0,
      storage_total: storageTotal,
    };
  });
}

/**
 * After a new user is created, set first_user_id and disable signup atomically
 * if this is the first user.
 * @param {string} userId - User ID of the newly created user
 */
async function handleFirstUserSetup(userId) {
  const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
  const userCount = parseInt(userCountResult.rows[0].count, 10);

  if (userCount === 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // first_user_id is immutable after this.
      await client.query(
        'UPDATE app_settings SET first_user_id = $1, signup_enabled = false, updated_at = NOW() WHERE id = $2 AND first_user_id IS NULL',
        [userId, 'app_settings']
      );

      await client.query('COMMIT');
      logger.info({ userId }, 'First user created, signup disabled by default');
    } catch (_err) {
      await client.query('ROLLBACK');
      // first_user_id already set — just disable signup.
      await setSignupEnabled(false, userId);
    } finally {
      client.release();
    }
  }
}

async function getUserStorageLimit(userId) {
  const result = await pool.query('SELECT storage_limit FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) {
    return null;
  }
  const limit = result.rows[0].storage_limit;
  // Postgres BIGINT may come back as a string for large numbers.
  if (limit === null || limit === undefined) {
    return null;
  }
  if (typeof limit === 'number') {
    return limit;
  }
  if (typeof limit === 'string') {
    const numLimit = Number(limit);
    return Number.isFinite(numLimit) ? numLimit : null;
  }
  return limit;
}

async function setUserStorageLimit(userId, targetUserId, storageLimit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'set storage limits');

    // Must be a positive integer or null.
    if (storageLimit !== null) {
      const limit = Number(storageLimit);

      if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
        await client.query('ROLLBACK');
        throw new Error('Storage limit must be a positive integer or null');
      }

      const MAX_STORAGE_LIMIT = 1024 * 1024 * 1024 * 1024 * 1024; // 1 Petabyte
      if (limit > MAX_STORAGE_LIMIT) {
        await client.query('ROLLBACK');
        throw new Error('Storage limit cannot exceed 1 Petabyte');
      }

      if (limit > Number.MAX_SAFE_INTEGER) {
        await client.query('ROLLBACK');
        throw new Error('Storage limit exceeds maximum safe value');
      }

      // On local disk, cap by actual VM disk space; S3 capacity is independent.
      if (!useS3) {
        const basePath = process.env.UPLOAD_DIR || __dirname;
        const actualDiskSize = await getActualDiskSize(basePath);
        if (limit > actualDiskSize) {
          const limitFormatted = formatFileSize(limit);
          const actualFormatted = formatFileSize(actualDiskSize);
          await client.query('ROLLBACK');
          throw new Error(`Storage limit (${limitFormatted}) cannot exceed actual disk space (${actualFormatted})`);
        }
      }
    }

    if (!targetUserId || typeof targetUserId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(targetUserId)) {
      await client.query('ROLLBACK');
      throw new Error('Invalid targetUserId format');
    }

    // A limit on a sub-user row is never consulted (files go to the owner), so
    // reject rather than silently no-op.
    const targetResult = await client.query('SELECT parent_user_id FROM users WHERE id = $1', [targetUserId]);
    if (targetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('User not found');
    }
    if (targetResult.rows[0].parent_user_id) {
      await client.query('ROLLBACK');
      throw new Error("Sub-users share their owner's storage limit; set the limit on the owner account instead");
    }

    // Reject a limit below current usage — it would strand the account over
    // quota and unable to upload.
    if (storageLimit !== null) {
      const usedResult = await client.query(
        `SELECT COALESCE(SUM(f.size), 0) AS used
           FROM files f
           JOIN users o ON o.id = f.user_id
          WHERE f.type = 'file' AND COALESCE(o.parent_user_id, o.id) = $1`,
        [targetUserId]
      );
      const used = Number(usedResult.rows[0].used) || 0;
      if (Number(storageLimit) < used) {
        const limitFormatted = formatFileSize(Number(storageLimit));
        const usedFormatted = formatFileSize(used);
        await client.query('ROLLBACK');
        throw new Error(`Storage limit (${limitFormatted}) is below the ${usedFormatted} this account already stores`);
      }
    }

    await client.query('UPDATE users SET storage_limit = $1 WHERE id = $2', [storageLimit, targetUserId]);

    await client.query('COMMIT');

    await deleteCache(cacheKeys.allUsers());
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { getTotalUserCount, getAllUsersBasic, handleFirstUserSetup, getUserStorageLimit, setUserStorageLimit };
