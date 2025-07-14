const { cleanupExpiredTrash } = require('../models/file.model');

let isTrashCleanupRunning = false;

async function runTrashCleanup() {
  if (isTrashCleanupRunning) {
    console.log('Trash cleanup already running, skipping...');
    return;
  }
  
  isTrashCleanupRunning = true;
  try {
    await cleanupExpiredTrash();
  } catch (error) {
    console.error('Trash cleanup failed:', error);
  } finally {
    isTrashCleanupRunning = false;
  }
}

function startTrashCleanup() {
  runTrashCleanup();
  setInterval(() => {
    runTrashCleanup();
  }, 24 * 60 * 60 * 1000);
}

module.exports = { startTrashCleanup };
