const { cleanupOrphanFiles } = require('../models/file.model');
const { createPeriodicCleanup } = require('../utils/cleanupScheduler');

const orphanCleanupTask = createPeriodicCleanup(cleanupOrphanFiles, 'Orphan cleanup', 24);

function startOrphanFileCleanup() {
  orphanCleanupTask.start();
}

module.exports = { startOrphanFileCleanup };
