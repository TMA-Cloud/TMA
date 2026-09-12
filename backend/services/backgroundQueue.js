const MAINTENANCE_QUEUE = 'background-maintenance';
const ONLYOFFICE_FORCESAVE_QUEUE = 'onlyoffice-forcesave';
const ORPHAN_MAINTENANCE_QUEUE = 'orphan-maintenance';
const FILE_OPERATION_QUEUE = 'file-operations';
// User-triggered file mutations use a separate FIFO queue. Keeping the legacy
// FILE_OPERATION_QUEUE lets already-enqueued jobs drain during an upgrade,
// while the keyed queue serializes new mutations for each account.
const ACCOUNT_FILE_OPERATION_QUEUE = 'account-file-operations';
const OBJECT_CLEANUP_QUEUE = 'object-cleanup';

const MAINTENANCE_TASKS = Object.freeze({
  TRASH: 'cleanup-expired-trash',
  AUDIT: 'cleanup-audit-log',
  SHARES: 'cleanup-expired-share-links',
  HEARTBEATS: 'cleanup-client-heartbeats',
  RESERVATIONS: 'cleanup-storage-reservations',
  SESSIONS: 'cleanup-old-sessions',
  OPERATION_RESULTS: 'cleanup-file-operation-results',
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
  await boss.createQueue(ACCOUNT_FILE_OPERATION_QUEUE, {
    policy: 'key_strict_fifo',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1800,
    heartbeatSeconds: 60,
    expireInSeconds: 6 * 60 * 60,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
  });
  await boss.createQueue(OBJECT_CLEANUP_QUEUE, {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 30 * 60,
    retentionSeconds: 7 * 24 * 60 * 60,
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
    [MAINTENANCE_TASKS.SESSIONS, '45 2 * * *'],
    [MAINTENANCE_TASKS.OPERATION_RESULTS, '50 2 * * *'],
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
  ACCOUNT_FILE_OPERATION_QUEUE,
  OBJECT_CLEANUP_QUEUE,
  MAINTENANCE_TASKS,
  initializeBackgroundQueues,
  initializeBackgroundSchedules,
};
