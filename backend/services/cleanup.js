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

export { cleanupOldAuditLogs };
