import { logger } from '../config/logger.js';
import storage from '../utils/storageDriver.js';
import { getBoss } from './auditLogger/queue.js';
import { OBJECT_CLEANUP_QUEUE } from './backgroundQueue.js';

function normalizeKeys(keys) {
  return [...new Set((Array.isArray(keys) ? keys : [keys]).filter(key => typeof key === 'string' && key.length > 0))];
}

/**
 * Durably hand unreferenced object deletion to the worker. In degraded mode,
 * delete immediately so cleanup remains best-effort rather than disappearing.
 */
async function enqueueObjectCleanup(keys, reason = 'unspecified') {
  const normalized = normalizeKeys(keys);
  if (normalized.length === 0) return null;

  const boss = getBoss();
  if (boss) {
    return boss.send(OBJECT_CLEANUP_QUEUE, { keys: normalized, reason });
  }

  logger.warn({ reason, count: normalized.length }, 'Object cleanup queue unavailable; deleting inline');
  const result = await storage.deleteObjects(normalized);
  if (result.errors?.length > 0) throw new Error(`${result.errors.length} object cleanup deletion(s) failed`);
  return null;
}

/** Execute one idempotent cleanup job in bounded storage API batches. */
async function deleteQueuedObjects({ keys } = {}) {
  const normalized = normalizeKeys(keys);
  let deleted = 0;
  for (let index = 0; index < normalized.length; index += 1000) {
    const batch = normalized.slice(index, index + 1000);
    const result = await storage.deleteObjects(batch);
    if (result.errors?.length > 0) throw new Error(`${result.errors.length} object cleanup deletion(s) failed`);
    deleted += batch.length;
  }
  return { deleted };
}

export { enqueueObjectCleanup, deleteQueuedObjects };
