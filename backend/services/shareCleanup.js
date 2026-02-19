const { cleanupExpiredShareLinks } = require('../models/share.model');
const { createPeriodicCleanup } = require('../utils/cleanupScheduler');

const shareCleanupTask = createPeriodicCleanup(cleanupExpiredShareLinks, 'Share link cleanup', 168);

function startShareCleanup() {
  shareCleanupTask.start();
}

module.exports = { startShareCleanup };
