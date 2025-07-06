const { cleanupOrphanFiles } = require('../models/file.model');

function startOrphanFileCleanup() {
  cleanupOrphanFiles().catch(() => {});
  setInterval(() => {
    cleanupOrphanFiles().catch(() => {});
  }, 24 * 60 * 60 * 1000);
}

module.exports = { startOrphanFileCleanup };
