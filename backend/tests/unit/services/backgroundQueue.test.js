import { describe, expect, it, vi } from 'vitest';

import {
  MAINTENANCE_QUEUE,
  MAINTENANCE_TASKS,
  ORPHAN_MAINTENANCE_QUEUE,
  FILE_OPERATION_QUEUE,
  ACCOUNT_FILE_OPERATION_QUEUE,
  OBJECT_CLEANUP_QUEUE,
  ONLYOFFICE_FORCESAVE_QUEUE,
  initializeBackgroundQueues,
  initializeBackgroundSchedules,
} from '../../../services/backgroundQueue.js';

describe('background queue topology', () => {
  it('creates durable maintenance and per-document force-save queues', async () => {
    const boss = { createQueue: vi.fn().mockResolvedValue(undefined) };
    await initializeBackgroundQueues(boss);
    expect(boss.createQueue).toHaveBeenCalledTimes(6);
    expect(boss.createQueue).toHaveBeenCalledWith(MAINTENANCE_QUEUE, expect.objectContaining({ policy: 'singleton' }));
    expect(boss.createQueue).toHaveBeenCalledWith(
      ONLYOFFICE_FORCESAVE_QUEUE,
      expect.objectContaining({ policy: 'key_strict_fifo', heartbeatSeconds: 60 })
    );
    expect(boss.createQueue).toHaveBeenCalledWith(ORPHAN_MAINTENANCE_QUEUE, expect.objectContaining({ retryLimit: 2 }));
    expect(boss.createQueue).toHaveBeenCalledWith(FILE_OPERATION_QUEUE, expect.objectContaining({ retryLimit: 3 }));
    expect(boss.createQueue).toHaveBeenCalledWith(
      ACCOUNT_FILE_OPERATION_QUEUE,
      expect.objectContaining({ policy: 'key_strict_fifo', retryLimit: 3 })
    );
    expect(boss.createQueue).toHaveBeenCalledWith(OBJECT_CLEANUP_QUEUE, expect.objectContaining({ retryLimit: 5 }));
  });

  it('registers each maintenance job under a distinct singleton schedule key', async () => {
    const boss = { schedule: vi.fn().mockResolvedValue(undefined) };
    await initializeBackgroundSchedules(boss);
    expect(boss.schedule).toHaveBeenCalledTimes(Object.keys(MAINTENANCE_TASKS).length);
    for (const task of Object.values(MAINTENANCE_TASKS)) {
      expect(boss.schedule).toHaveBeenCalledWith(
        MAINTENANCE_QUEUE,
        expect.any(String),
        { task },
        expect.objectContaining({ key: task, singletonKey: task, tz: 'UTC' })
      );
    }
  });
});
