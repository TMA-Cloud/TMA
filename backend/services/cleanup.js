import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import { createPeriodicCleanup } from '../utils/cleanupScheduler.js';
import { cleanupExpiredTrash, cleanupOrphanFiles } from '../models/file/file.cleanup.model.js';
import { cleanupExpiredShareLinks } from '../models/share.model.js';
import { purgeStaleHeartbeats } from '../models/clientHeartbeat.model.js';

const HEARTBEAT_STALE_MINUTES = 10;

/**
 * Clean up old audit logs via the PostgreSQL cleanup_old_audit_logs function.
 */
async function cleanupOldAuditLogs() {
  const client = await pool.connect();
  try {
    logger.info('Starting audit log cleanup...');
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

const CLEANUP_JOBS = [
  { fn: cleanupExpiredTrash, name: 'Trash cleanup', intervalHours: 24 },
  { fn: cleanupOldAuditLogs, name: 'Audit log cleanup', intervalHours: 24 },
  { fn: cleanupOrphanFiles, name: 'Orphan cleanup', intervalHours: 24 },
  { fn: cleanupExpiredShareLinks, name: 'Share link cleanup', intervalHours: 168 },
  { fn: () => purgeStaleHeartbeats(HEARTBEAT_STALE_MINUTES), name: 'Heartbeat cleanup', intervalHours: 1 },
];

function startCleanupJobs() {
  for (const { fn, name, intervalHours } of CLEANUP_JOBS) {
    createPeriodicCleanup(fn, name, intervalHours).start();
  }
}

export { startCleanupJobs, cleanupOldAuditLogs };
