/**
 * Rewrap every stored data key under the primary master key after a rotation.
 * Only the ~60-byte wrapped keys change; file bodies in the bucket are never
 * read or rewritten. Safe to interrupt and run again, and safe to run from two
 * processes at once, so the worker runs it on start and `npm run rotate`
 * runs it on demand.
 */

import { logger } from '../config/logger.js';
import { applyRewraps, fetchRewrapPage } from '../models/kekRewrap.model.js';
import { rewrapStorageSecret } from '../models/user/user.admin.storage.model.js';
import { primaryKekVersion, rewrapDekToPrimary } from '../utils/fileEncryption.js';
import { withRetries } from '../utils/retry.js';

const PAGE_SIZE = 500;

const onRetry =
  label =>
  (err, { attempt, retries, backoff }) =>
    logger.warn({ err, attempt, retries, backoff }, `[KeyRewrap] Transient error on ${label}, retrying`);

/**
 * @param {object} [opts]
 * @param {(progress: { rewrapped: number, failed: number }) => void} [opts.onProgress] after each page
 * @returns {Promise<{ primary: number, storageSecret: boolean, rewrapped: number,
 *   failures: Array<{ id: string, fromVersion: number, error: string }> }>}
 */
async function rewrapToPrimaryKey({ onProgress } = {}) {
  const primary = primaryKekVersion();
  const storageSecret = await rewrapStorageSecret();

  let rewrapped = 0;
  const failures = [];
  // The cursor passes rows that fail too, so one bad row cannot stall the run.
  let cursor = '';
  for (;;) {
    const rows = await withRetries(() => fetchRewrapPage(primary, cursor, PAGE_SIZE), {
      onRetry: onRetry('fetch'),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    const updates = [];
    for (const row of rows) {
      try {
        const next = rewrapDekToPrimary(row.dekWrapped, row.dekKekVersion);
        if (next) updates.push({ id: row.id, fromVersion: row.dekKekVersion, ...next });
      } catch (err) {
        failures.push({ id: row.id, fromVersion: row.dekKekVersion, error: err.message });
      }
    }
    rewrapped += await withRetries(() => applyRewraps(updates), { onRetry: onRetry('update') });
    onProgress?.({ rewrapped, failed: failures.length });
  }
  return { primary, storageSecret, rewrapped, failures };
}

export { rewrapToPrimaryKey };
