const MAINTENANCE_QUEUE = 'background-maintenance';
const ONLYOFFICE_FORCESAVE_QUEUE = 'onlyoffice-forcesave';
const ORPHAN_MAINTENANCE_QUEUE = 'orphan-maintenance';
const FILE_OPERATION_QUEUE = 'file-operations';
// User-triggered file mutations use a separate FIFO queue. Keeping the legacy
// FILE_OPERATION_QUEUE lets already-enqueued jobs drain during an upgrade,
// while the keyed queue serializes new mutations for each account.
const ACCOUNT_FILE_OPERATION_QUEUE = 'account-file-operations';
const OBJECT_CLEANUP_QUEUE = 'object-cleanup';
// Auto-linking newly created items into an ancestor's share is a recursive
// subtree write that no response body depends on, so it rides its own queue
// instead of the upload request.
const SHARE_LINK_QUEUE = 'share-linking';

const MAINTENANCE_TASKS = Object.freeze({
  TRASH: 'cleanup-expired-trash',
  AUDIT: 'cleanup-audit-log',
  SHARES: 'cleanup-expired-share-links',
  HEARTBEATS: 'cleanup-client-heartbeats',
  RESERVATIONS: 'cleanup-storage-reservations',
  SESSIONS: 'cleanup-old-sessions',
  OPERATION_RESULTS: 'cleanup-file-operation-results',
  IMPORT_MANIFESTS: 'cleanup-bulk-import-manifests',
  FOLDER_AGGREGATES: 'reconcile-folder-aggregates',
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
  await boss.createQueue(SHARE_LINK_QUEUE, {
    policy: 'key_strict_fifo',
    retryLimit: 5,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 15 * 60,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 60 * 60,
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
  // Spread across the window rather than stacked on the hour: a single worker
  // runs these serially, so coinciding start times only queue them behind each
  // other and pile their load onto the same minutes of database time.
  const schedules = [
    [MAINTENANCE_TASKS.TRASH, '0 2 * * *'],
    [MAINTENANCE_TASKS.AUDIT, '40 3 * * *'],
    [MAINTENANCE_TASKS.SESSIONS, '20 4 * * *'],
    [MAINTENANCE_TASKS.OPERATION_RESULTS, '50 4 * * *'],
    [MAINTENANCE_TASKS.IMPORT_MANIFESTS, '25 5 * * *'],
    [MAINTENANCE_TASKS.FOLDER_AGGREGATES, '15 1 * * 0'],
    [MAINTENANCE_TASKS.SHARES, '10 6 * * 0'],
    [MAINTENANCE_TASKS.HEARTBEATS, '7 * * * *'],
    [MAINTENANCE_TASKS.RESERVATIONS, '37 * * * *'],
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
  SHARE_LINK_QUEUE,
  MAINTENANCE_TASKS,
  initializeBackgroundQueues,
  initializeBackgroundSchedules,
};
