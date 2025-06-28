const { cleanupExpiredTrash } = require('../models/file.model');

function startTrashCleanup() {
  cleanupExpiredTrash().catch(() => {});
  setInterval(() => {
    cleanupExpiredTrash().catch(() => {});
  }, 24 * 60 * 60 * 1000);
}

module.exports = { startTrashCleanup };
