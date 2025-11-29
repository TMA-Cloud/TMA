/**
 * Generic cleanup scheduler utility
 * Creates a scheduled cleanup task that runs immediately and then at intervals
 */
function createPeriodicCleanup(cleanupFn, name, intervalHours = 24) {
  let isRunning = false;

  async function runCleanup() {
    if (isRunning) {
      logger.info(`${name} already running, skipping...`);
      return;
    }

    isRunning = true;
    try {
      await cleanupFn();
    } catch (error) {
      logger.error(`${name} failed:`, error);
    } finally {
      isRunning = false;
    }
  }

  function start() {
    runCleanup();
    setInterval(() => {
      runCleanup();
    }, intervalHours * 60 * 60 * 1000);
  }

  return { start, runCleanup };
}

module.exports = { createPeriodicCleanup };
