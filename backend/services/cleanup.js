import pool from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * Clean up old audit logs via the PostgreSQL cleanup_old_audit_logs function.
 */
async function cleanupOldAuditLogs() {
  const client = await pool.connect();
  try {
    logger.info('Starting audit log cleanup...');
    let deletedCount = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.query('SELECT cleanup_old_audit_logs(30)');
      const deleted = Number(result.rows[0].cleanup_old_audit_logs) || 0;
      deletedCount += deleted;
      if (deleted < 10000) break;
    }
    logger.info({ deletedCount }, `Audit log cleanup completed - ${deletedCount} entries deleted`);
    return deletedCount;
  } catch (error) {
    logger.error({ err: error }, 'Failed to cleanup audit logs');
    throw error;
  } finally {
    client.release();
  }
}

/** Remove expired idempotency records after pg-boss job results have expired. */
async function cleanupOldFileOperationResults(daysOld = 30, { batchSize = 5000, maxBatches = 20 } = {}) {
  let deletedCount = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query(
      `WITH doomed AS (
         SELECT job_id FROM file_operation_results
          WHERE completed_at < NOW() - INTERVAL '1 day' * $1
          ORDER BY completed_at, job_id
          LIMIT $2
       )
       DELETE FROM file_operation_results r USING doomed
        WHERE r.job_id = doomed.job_id`,
      [daysOld, batchSize]
    );
    const deleted = result.rowCount || 0;
    deletedCount += deleted;
    if (deleted < batchSize) break;
  }
  return deletedCount;
}

export { cleanupOldAuditLogs, cleanupOldFileOperationResults };
