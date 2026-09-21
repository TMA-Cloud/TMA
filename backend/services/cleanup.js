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

/**
 * Drop bulk-import manifests left behind by a run that never finished.
 *
 * `scripts/bulkImportDrive.js` deletes its own rows on success and on rollback;
 * only a killed process leaves them. The age threshold is what keeps this safe:
 * an in-flight import's rows are minutes old, so nothing an operator could
 * still roll back is ever removed.
 */
async function cleanupStaleImportManifests(daysOld = 7, { batchSize = 5000, maxBatches = 20 } = {}) {
  let deletedCount = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query(
      `WITH doomed AS (
         SELECT run_id, file_id FROM bulk_import_items
          WHERE created_at < NOW() - INTERVAL '1 day' * $1
          ORDER BY created_at, run_id
          LIMIT $2
       )
       DELETE FROM bulk_import_items i USING doomed
        WHERE i.run_id = doomed.run_id AND i.file_id = doomed.file_id`,
      [daysOld, batchSize]
    );
    const deleted = result.rowCount || 0;
    deletedCount += deleted;
    if (deleted < batchSize) break;
  }
  if (deletedCount > 0) logger.info({ deletedCount, daysOld }, 'Purged stale bulk-import manifests');
  return deletedCount;
}

export { cleanupOldAuditLogs, cleanupOldFileOperationResults, cleanupStaleImportManifests };
