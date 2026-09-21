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

/**
 * Recompute folder aggregates per account and report what was wrong.
 *
 * The aggregate columns are the only source of a folder's size and counts, and
 * incremental trigger maintenance can drift: adjust_file_ancestor_aggregates()
 * clamps at zero, so a delta that would go negative is lost rather than
 * corrected. A repaired count above zero means a write path is not maintaining
 * them, which is worth looking at even though this run has already fixed it.
 */
async function reconcileFolderAggregates({ maxRuntimeMs = 20 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  const { rows: accounts } = await pool.query('SELECT id FROM users ORDER BY id');
  let scanned = 0;
  let repaired = 0;

  for (const account of accounts) {
    if (Date.now() - startedAt >= maxRuntimeMs) break;
    const result = await pool.query('SELECT reconcile_folder_aggregates($1) AS repaired', [account.id]);
    const drifted = Number(result.rows[0].repaired) || 0;
    scanned += 1;
    repaired += drifted;
    if (drifted > 0) {
      logger.warn({ userId: account.id, folders: drifted }, 'Repaired drifted folder aggregates');
    }
  }

  const incomplete = scanned < accounts.length;
  logger.info(
    { scanned, accounts: accounts.length, repaired, incomplete },
    'Folder aggregate reconciliation completed'
  );
  return { scanned, repaired, incomplete };
}

export { cleanupOldAuditLogs, cleanupOldFileOperationResults, cleanupStaleImportManifests, reconcileFolderAggregates };
