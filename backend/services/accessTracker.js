import pool from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * Last-access tracking for files and folders.
 *
 * Recording "this was opened" is cheap to describe and expensive to implement
 * naively: every read becomes a row update, every row update invalidates a
 * cache entry, and a directory listing multiplies both by the number of
 * children. Filesystems hit this problem decades ago and answered it the same
 * way twice — coalesce the writes and accept a loose timestamp:
 *
 *   NTFS promises the value is accurate only to within an hour.
 *   Linux's `relatime` rewrites atime only when it predates the last write or
 *   is more than a day stale, and `lazytime` holds the update in memory and
 *   lets something else carry it to disk later.
 *
 * This module does both:
 *
 *   1. A per-item suppression window (default one hour). Re-reading the same
 *      item inside its window costs nothing at all — no query, no queue entry.
 *   2. A write-behind buffer. Everything that survives step 1 lands in memory
 *      and is written by one bulk UPDATE per flush interval, so the database
 *      cost is bounded by wall-clock time rather than by traffic.
 *
 * The result is at most one row write per item per hour, batched. A user who
 * downloads the same file forty times in a morning produces one.
 *
 * Callers treat this as fire-and-forget: nothing here is awaited on a request
 * path and nothing here throws. A lost timestamp is not worth a failed
 * download.
 */

/** Read a positive number from the environment, falling back when unset or junk. */
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Windows exposes an off switch for exactly this feature
// (NtfsDisableLastAccessUpdate) because on a busy volume the writes cost more
// than the timestamps are worth. Deployments that feel the same can say so.
const TRACKING_DISABLED = ['0', 'false', 'off', 'no'].includes(
  String(process.env.ACCESS_TIME_TRACKING || '').toLowerCase()
);

/** How stale a stored timestamp must be before a read is worth writing down. */
const WINDOW_MS = envNumber('ACCESS_TIME_WINDOW_MINUTES', 60) * 60 * 1000;

/** How long buffered timestamps may sit in memory before being written. */
const FLUSH_INTERVAL_MS = envNumber('ACCESS_TIME_FLUSH_SECONDS', 10) * 1000;

/**
 * Flush early once this many items are waiting. A folder download can push a
 * whole tree in at once; this keeps the buffer from tracking the tree's size.
 */
const MAX_PENDING = 2000;

/** Rows per UPDATE statement, so one huge flush cannot build a huge query. */
const CHUNK_SIZE = 500;

/**
 * Ceiling on remembered suppression windows. Hitting it costs some redundant
 * writes, never correctness, so the recovery is simply to forget.
 */
const MAX_SUPPRESSED = 50000;

/** key -> { id, ownerId, at } awaiting a write. */
const pending = new Map();

/** key -> epoch ms at which this item may be written down again. */
const suppressed = new Map();

let flushTimer = null;
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
  if (TRACKING_DISABLED || !ownerId || ids == null) return;

  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return;

  const now = Date.now();
  const at = new Date(now);

  for (const id of list) {
    if (!id) continue;
    const k = key(ownerId, id);

    // Inside its window the stored value is already "recent enough" by the
    // same standard NTFS applies, so there is nothing to do.
    const openAgainAt = suppressed.get(k);
    if (openAgainAt !== undefined && openAgainAt > now) continue;

    suppressed.set(k, now + WINDOW_MS);
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
 * Write one batch.
 *
 * Deliberately touches `accessed_at` and nothing else: `modified` must keep
 * meaning "when the contents changed", or sorting by it becomes sorting by
 * whoever browsed most recently.
 *
 * The `f.accessed_at < v.accessed_at` guard makes the statement idempotent and
 * stops a delayed flush from dragging a newer timestamp backwards.
 *
 * No cache is invalidated afterwards, and that is deliberate. Listings are
 * cached for a minute; dropping those entries on every read would trade the
 * cache's whole value for precision this timestamp does not claim to have —
 * it is already allowed to lag by an hour.
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
 * Write everything buffered so far.
 * @returns {Promise<number>} Rows actually updated
 */
async function flushAccessTimes() {
  if (flushing || pending.size === 0) return 0;

  flushing = true;
  const batch = Array.from(pending.entries());
  pending.clear();

  // A stable row order keeps two concurrent flushes from taking the same locks
  // in opposite orders.
  batch.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let written = 0;
  try {
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      written += await flushChunk(chunk.map(([, entry]) => entry));
    }
  } catch (err) {
    // Nothing was stored, so the suppression windows are lies. Forget them and
    // let the next read try again rather than going quiet for an hour.
    for (const [k] of batch) suppressed.delete(k);
    logger.warn({ err, count: batch.length }, '[AccessTime] Failed to flush access times');
  } finally {
    flushing = false;
  }

  return written;
}

/** Begin writing buffered timestamps on an interval. */
function startAccessTracker() {
  if (TRACKING_DISABLED) {
    logger.info('[AccessTime] Access time tracking disabled by configuration');
    return;
  }
  if (flushTimer) return;

  flushTimer = setInterval(() => {
    void flushAccessTimes();
  }, FLUSH_INTERVAL_MS);

  // Buffered timestamps are not a reason to keep the process alive.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();

  logger.info(
    { windowMinutes: WINDOW_MS / 60000, flushSeconds: FLUSH_INTERVAL_MS / 1000 },
    '[AccessTime] Access time tracker started'
  );
}

/** Stop the interval and write out whatever is still buffered. */
async function shutdownAccessTracker() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushAccessTimes();
}

/** Test seam: drop all buffered and suppressed state. */
function resetAccessTracker() {
  pending.clear();
  suppressed.clear();
  flushing = false;
}

export {
  recordAccess,
  flushAccessTimes,
  startAccessTracker,
  shutdownAccessTracker,
  resetAccessTracker,
  WINDOW_MS,
  MAX_PENDING,
  CHUNK_SIZE,
};
