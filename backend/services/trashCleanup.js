const { cleanupExpiredTrash } = require('../models/file.model');
const { createPeriodicCleanup } = require('../utils/cleanupScheduler');

const trashCleanupTask = createPeriodicCleanup(cleanupExpiredTrash, 'Trash cleanup', 24);

function startTrashCleanup() {
  trashCleanupTask.start();
}

module.exports = { startTrashCleanup };
