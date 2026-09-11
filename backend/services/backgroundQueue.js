const MAINTENANCE_QUEUE = 'background-maintenance';
const ONLYOFFICE_FORCESAVE_QUEUE = 'onlyoffice-forcesave';
const ORPHAN_MAINTENANCE_QUEUE = 'orphan-maintenance';
const FILE_OPERATION_QUEUE = 'file-operations';

const MAINTENANCE_TASKS = Object.freeze({
  TRASH: 'cleanup-expired-trash',
  AUDIT: 'cleanup-audit-log',
  SHARES: 'cleanup-expired-share-links',
  HEARTBEATS: 'cleanup-client-heartbeats',
  RESERVATIONS: 'cleanup-storage-reservations',
});

const BACKGROUND_QUEUE_OPTIONS = {
  policy: 'singleton',
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 3600,
  heartbeatSeconds: 60,
  expireInSeconds: 60 * 60,
  retentionSeconds: 7 * 24 * 60 * 60,
};

async function initializeBackgroundQueues(boss) {
  await boss.createQueue(MAINTENANCE_QUEUE, BACKGROUND_QUEUE_OPTIONS);
  await boss.createQueue(ONLYOFFICE_FORCESAVE_QUEUE, {
    ...BACKGROUND_QUEUE_OPTIONS,
    policy: 'key_strict_fifo',
    expireInSeconds: 5 * 60,
  });
  await boss.createQueue(ORPHAN_MAINTENANCE_QUEUE, {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 60 * 60,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
  });
  await boss.createQueue(FILE_OPERATION_QUEUE, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1800,
    heartbeatSeconds: 60,
    expireInSeconds: 6 * 60 * 60,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
  });
}

/** Durable cron schedules; pg-boss de-duplicates them by schedule key. */
async function initializeBackgroundSchedules(boss) {
  const schedules = [
    [MAINTENANCE_TASKS.TRASH, '0 2 * * *'],
    [MAINTENANCE_TASKS.AUDIT, '15 2 * * *'],
    [MAINTENANCE_TASKS.SHARES, '0 3 * * 0'],
    [MAINTENANCE_TASKS.HEARTBEATS, '0 * * * *'],
    [MAINTENANCE_TASKS.RESERVATIONS, '30 * * * *'],
  ];
  for (const [task, cron] of schedules) {
    await boss.schedule(MAINTENANCE_QUEUE, cron, { task }, { key: task, tz: 'UTC', singletonKey: task });
  }
}

export {
  MAINTENANCE_QUEUE,
  ONLYOFFICE_FORCESAVE_QUEUE,
  ORPHAN_MAINTENANCE_QUEUE,
  FILE_OPERATION_QUEUE,
  MAINTENANCE_TASKS,
  initializeBackgroundQueues,
  initializeBackgroundSchedules,
};
