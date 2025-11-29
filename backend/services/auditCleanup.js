const pool = require('../config/db');
const { createPeriodicCleanup } = require('../utils/cleanupScheduler');
const { logger } = require('../config/logger');

/**
 * Clean up old audit logs
 * Calls the PostgreSQL cleanup_old_audit_logs function
 */
async function cleanupOldAuditLogs() {
  const client = await pool.connect();
  try {
    logger.info('Starting audit log cleanup...');

    // Call the PostgreSQL function that deletes old audit logs
    const result = await client.query('SELECT cleanup_old_audit_logs(30)');
    const deletedCount = result.rows[0].cleanup_old_audit_logs;

    logger.info({ deletedCount }, `Audit log cleanup completed - ${deletedCount} entries deleted`);

    return deletedCount;
  } catch (error) {
    logger.error({ err: error }, 'Failed to cleanup audit logs');
    throw error;
  } finally {
    client.release();
  }
}

// Create periodic cleanup task (runs every 24 hours)
const auditCleanupTask = createPeriodicCleanup(
  cleanupOldAuditLogs,
  'Audit log cleanup',
  24 // Run every 24 hours
);

function startAuditCleanup() {
  logger.info('Audit cleanup scheduler initialized');
  auditCleanupTask.start();
}

module.exports = { startAuditCleanup, cleanupOldAuditLogs };
