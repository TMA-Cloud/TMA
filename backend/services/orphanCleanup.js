import { cleanupOrphanFiles } from '../models/file/file.cleanup.model.js';
import { createPeriodicCleanup } from '../utils/cleanupScheduler.js';

const orphanCleanupTask = createPeriodicCleanup(cleanupOrphanFiles, 'Orphan cleanup', 24);

function startOrphanFileCleanup() {
  orphanCleanupTask.start();
}

export { startOrphanFileCleanup };
