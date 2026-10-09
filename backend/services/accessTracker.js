import { getActivitySettings } from '../config/activitySettings.js';
import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import { cacheKeys, deleteCache } from '../utils/cache.js';

/**
 * Last-access tracking for files and folders. Like NTFS/relatime, it coalesces
 * writes and accepts a loose timestamp: a per-item suppression window (one hour
 * by default) drops repeat reads for free, and a write-behind buffer flushes the
 * survivors as one bulk UPDATE per interval — at most one write per item/window.
 * The first user sets the switch, window and interval in Settings; like NTFS's
 * NtfsDisableLastAccessUpdate, tracking can be turned off on busy deployments.
 * Fire-and-forget: nothing here is awaited on a request path or throws.
 */

/** How stale a stored timestamp must be before a read is worth writing down. */
const windowMs = () => getActivitySettings().accessTimeWindowMinutes * 60 * 1000;

/** Flush early once this many items are waiting (a folder download bursts many). */
const MAX_PENDING = 2000;

/** Rows per UPDATE statement, so one huge flush cannot build a huge query. */
const CHUNK_SIZE = 500;

/** Ceiling on remembered suppression windows; overflow just forgets (costs redundant writes). */
const MAX_SUPPRESSED = 50000;

/** key -> { id, ownerId, at } awaiting a write. */
const pending = new Map();

/** key -> epoch ms at which this item may be written down again. */
const suppressed = new Map();

let flushTimer = null;
let flushIntervalMs = 0;
let flushing = false;

const key = (ownerId, id) => `${ownerId}:${id}`;

/**
 * Drop suppression windows that have expired, and if the map is still over its
 * ceiling, drop the rest as well.
 */
function pruneSuppressed(now) {
  for (const [k, expiresAt] of suppressed) {
    if (expiresAt <= now) suppressed.delete(k);
  }
  if (suppressed.size > MAX_SUPPRESSED) {
    suppressed.clear();
  }
}

/**
 * Note that items were read.
 *
 * @param {string|string[]} ids - File/folder id(s) that were read
 * @param {string} ownerId - Account owner the rows belong to (req.ownerId)
 */
function recordAccess(ids, ownerId) {
  if (!getActivitySettings().accessTimeTracking || !ownerId || ids == null) return;

  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return;

  const now = Date.now();
  const at = new Date(now);
  const window = windowMs();

  for (const id of list) {
    if (!id) continue;
    const k = key(ownerId, id);

    // Inside its window the stored value is already recent enough.
    const openAgainAt = suppressed.get(k);
    if (openAgainAt !== undefined && openAgainAt > now) continue;

    suppressed.set(k, now + window);
    pending.set(k, { id, ownerId, at });
  }

  if (suppressed.size > MAX_SUPPRESSED) {
    pruneSuppressed(now);
  }

  if (pending.size >= MAX_PENDING) {
    void flushAccessTimes();
  }
}

/**
 * Write one batch. Touches only `accessed_at` (never `modified`); the
 * `accessed_at < v.accessed_at` guard is idempotent and won't move a timestamp
 * backwards. Folder listings are left to expire on their own — only the
 * recently-opened list is invalidated, in flushAccessTimes.
 */
async function flushChunk(entries) {
  const tuples = [];
  const params = [];

  entries.forEach(({ id, ownerId, at }, index) => {
    const base = index * 3;
    tuples.push(`($${base + 1}::text, $${base + 2}::text, $${base + 3}::timestamptz)`);
    params.push(id, ownerId, at);
  });

  const result = await pool.query(
    `UPDATE files AS f
        SET accessed_at = v.accessed_at
       FROM (VALUES ${tuples.join(',')}) AS v(id, user_id, accessed_at)
      WHERE f.id = v.id
        AND f.user_id = v.user_id
        AND f.deleted_at IS NULL
        AND f.accessed_at < v.accessed_at`,
    params
  );

  return result.rowCount || 0;
}

/**
 * Drop the cached "recently opened" list per account in a flushed batch — the
 * one cache these timestamps genuinely order. Rides the flush (one DEL per
 * account per interval); a failure just means a stale panel for one TTL.
 */
async function invalidateRecentLists(batch) {
  const owners = new Set(batch.map(([, entry]) => entry.ownerId));
  for (const ownerId of owners) {
    try {
      await deleteCache(cacheKeys.recentFiles(ownerId));
    } catch (err) {
      logger.warn({ err, ownerId }, '[AccessTime] Failed to invalidate recent files cache');
    }
  }
}

/**
 * Write everything buffered so far.
 * @returns {Promise<number>} Rows actually updated
 */
async function flushAccessTimes() {
  if (flushing || pending.size === 0) return 0;

  flushing = true;
  const batch = Array.from(pending.entries());
  pending.clear();

  // Stable order so concurrent flushes don't take locks in opposite orders.
  batch.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let written = 0;
  try {
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      written += await flushChunk(chunk.map(([, entry]) => entry));
    }
    if (written > 0) await invalidateRecentLists(batch);
  } catch (err) {
    // Nothing stored — forget the suppression windows so the next read retries.
    for (const [k] of batch) suppressed.delete(k);
    logger.warn({ err, count: batch.length }, '[AccessTime] Failed to flush access times');
  } finally {
    flushing = false;
  }

  return written;
}

function stopTimer() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  flushIntervalMs = 0;
}

/**
 * Follow the current settings: start, stop or re-time the flush interval.
 * Called at startup and whenever the settings change.
 */
function configureAccessTracker(settings = getActivitySettings()) {
  if (!settings.accessTimeTracking) {
    if (!flushTimer) return;
    stopTimer();
    // What was already buffered is still true, so it is written, not dropped.
    void flushAccessTimes();
    suppressed.clear();
    logger.info('[AccessTime] Access time tracking turned off');
    return;
  }

  const intervalMs = settings.accessTimeFlushSeconds * 1000;
  if (flushTimer && intervalMs === flushIntervalMs) return;

  stopTimer();
  flushTimer = setInterval(() => {
    void flushAccessTimes();
  }, intervalMs);
  flushIntervalMs = intervalMs;
  // Buffered timestamps are not a reason to keep the process alive.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();

  logger.info(
    { windowMinutes: settings.accessTimeWindowMinutes, flushSeconds: settings.accessTimeFlushSeconds },
    '[AccessTime] Access time tracker running'
  );
}

/** Stop the interval and write out whatever is still buffered. */
async function shutdownAccessTracker() {
  stopTimer();
  await flushAccessTimes();
}

/** Test seam: drop all buffered and suppressed state. */
function resetAccessTracker() {
  stopTimer();
  pending.clear();
  suppressed.clear();
  flushing = false;
}

export {
  recordAccess,
  flushAccessTimes,
  configureAccessTracker,
  shutdownAccessTracker,
  resetAccessTracker,
  CHUNK_SIZE,
};
