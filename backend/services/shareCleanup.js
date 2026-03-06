import { cleanupExpiredShareLinks } from '../models/share.model.js';
import { createPeriodicCleanup } from '../utils/cleanupScheduler.js';

const shareCleanupTask = createPeriodicCleanup(cleanupExpiredShareLinks, 'Share link cleanup', 168);

function startShareCleanup() {
  shareCleanupTask.start();
}

export { startShareCleanup };
