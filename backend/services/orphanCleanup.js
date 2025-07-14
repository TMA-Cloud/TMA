const { cleanupOrphanFiles } = require('../models/file.model');

let isCleanupRunning = false;

async function runOrphanCleanup() {
  if (isCleanupRunning) {
    console.log('Orphan cleanup already running, skipping...');
    return;
  }
  
  isCleanupRunning = true;
  try {
    await cleanupOrphanFiles();
  } catch (error) {
    console.error('Orphan cleanup failed:', error);
  } finally {
    isCleanupRunning = false;
  }
}

function startOrphanFileCleanup() {
  runOrphanCleanup();
  setInterval(() => {
    runOrphanCleanup();
  }, 24 * 60 * 60 * 1000);
}

module.exports = { startOrphanFileCleanup };
