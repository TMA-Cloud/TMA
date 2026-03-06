import { cleanupExpiredTrash } from '../models/file/file.cleanup.model.js';
import { createPeriodicCleanup } from '../utils/cleanupScheduler.js';

const trashCleanupTask = createPeriodicCleanup(cleanupExpiredTrash, 'Trash cleanup', 24);

function startTrashCleanup() {
  trashCleanupTask.start();
}

export { startTrashCleanup };
