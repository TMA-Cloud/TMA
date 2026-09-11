import pool from '../config/db.js';
import { generateId } from '../utils/id.js';

async function reserveStorage(userId, bytes, purpose, ttlHours = 24) {
  const amount = Number(bytes) || 0;
  if (amount <= 0) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query(
      'SELECT storage_used, storage_reserved, storage_limit FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (account.rows.length === 0) throw new Error('Storage account not found');
    const row = account.rows[0];
    const limit = row.storage_limit == null ? null : Number(row.storage_limit);
    if (limit !== null && Number(row.storage_used || 0) + Number(row.storage_reserved || 0) + amount > limit) {
      const error = new Error('Storage limit exceeded');
      error.code = 'STORAGE_LIMIT_EXCEEDED';
      throw error;
    }
    const id = generateId(16);
    await client.query(
      `INSERT INTO storage_reservations(id, user_id, bytes, purpose, expires_at)
       VALUES($1, $2, $3, $4, NOW() + make_interval(hours => $5))`,
      [id, userId, amount, purpose, ttlHours]
    );
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function releaseStorageReservation(id, queryable = pool) {
  if (!id) return 0;
  const result = await queryable.query('DELETE FROM storage_reservations WHERE id = $1', [id]);
  return result.rowCount || 0;
}

async function cleanupExpiredStorageReservations(batchSize = 1000, maxBatches = 100) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query(
      `WITH expired AS (
         SELECT id FROM storage_reservations
          WHERE expires_at <= NOW()
          ORDER BY expires_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM storage_reservations r USING expired e
        WHERE r.id = e.id
       RETURNING r.id`,
      [batchSize]
    );
    deleted += result.rowCount || 0;
    if (result.rowCount < batchSize) return deleted;
  }
  return deleted;
}

export { reserveStorage, releaseStorageReservation, cleanupExpiredStorageReservations };
