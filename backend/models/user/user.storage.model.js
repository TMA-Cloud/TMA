import pool from '../../config/db.js';
/**
 * Get transactionally maintained storage usage for an account.
 * Includes files in trash (deleted_at IS NOT NULL) as they still consume storage.
 */
async function getUserStorageUsage(userId) {
  const res = await pool.query(
    `SELECT COALESCE(account.storage_used, 0) AS used
       FROM users actor
       JOIN users account ON account.id = COALESCE(actor.parent_user_id, actor.id)
      WHERE actor.id = $1`,
    [userId]
  );
  return Number(res.rows[0]?.used) || 0;
}

export { getUserStorageUsage };
