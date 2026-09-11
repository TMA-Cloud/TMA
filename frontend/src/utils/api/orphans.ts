/** Admin orphan-storage report and cleanup (objects/rows with no counterpart). */
import { apiGet, apiPost } from './client';

/** An object in storage that no database row points at. */
export interface StorageOrphan {
  key: string;
  size: number;
  lastModified: string | null;
}

/** A database row whose stored object is missing. */
export interface DatabaseOrphan {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string | null;
  modified: string | null;
  createdAt: string;
  trashed: boolean;
  ownerEmail: string | null;
  ownerName: string | null;
}

interface OrphanGroup<T> {
  items: T[];
  count: number;
  totalBytes: number;
  /** True when `count` exceeds the number of items returned. */
  truncated: boolean;
}

export interface OrphanReport {
  scannedAt: string;
  graceMinutes: number;
  driver: 's3';
  totals: {
    storedObjects: number;
    databaseRows: number;
    /** Entries held back because they are younger than the grace window. */
    skippedTooRecent: number;
  };
  storageOrphans: OrphanGroup<StorageOrphan>;
  databaseOrphans: OrphanGroup<DatabaseOrphan>;
}

export interface OrphanDeleteResult {
  graceMinutes: number;
  storage: {
    results: Array<{ key: string; deleted: boolean; reason?: string }>;
    deleted: number;
    skipped: number;
  };
  database: {
    results: Array<{ id: string; deleted: boolean; reason?: string }>;
    deleted: number;
    skipped: number;
  };
}

interface BackgroundJobState<T> {
  jobId?: string;
  status?: string;
  result?: T;
}

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function pollJob<T>(request: () => Promise<T | BackgroundJobState<T>>): Promise<T> {
  const started = Date.now();
  let delay = 1000;
  for (;;) {
    const response = await request();
    if (!response || typeof response !== 'object' || !('jobId' in response)) return response as T;
    if (Date.now() - started > 10 * 60 * 1000) throw new Error('Background maintenance timed out');
    await wait(delay);
    delay = Math.min(5000, delay * 2);
  }
}

export async function fetchOrphans(graceMinutes: number): Promise<OrphanReport> {
  const queued = await apiGet<BackgroundJobState<OrphanReport>>(
    `/api/user/orphans?graceMinutes=${encodeURIComponent(graceMinutes)}`
  );
  if (!queued.jobId) return queued as unknown as OrphanReport;
  return pollJob(() =>
    apiGet<OrphanReport | BackgroundJobState<OrphanReport>>(`/api/user/orphans?jobId=${queued.jobId}`)
  );
}

export async function deleteOrphans(payload: {
  storageKeys?: string[];
  fileIds?: string[];
  graceMinutes: number;
}): Promise<OrphanDeleteResult> {
  const queued = await apiPost<BackgroundJobState<OrphanDeleteResult>>('/api/user/orphans/delete', payload);
  if (!queued.jobId) return queued as unknown as OrphanDeleteResult;
  return pollJob(() =>
    apiPost<OrphanDeleteResult | BackgroundJobState<OrphanDeleteResult>>('/api/user/orphans/delete', {
      jobId: queued.jobId,
    })
  );
}

/**
 * Max entries of each kind the backend accepts per delete request
 * (MAX_DELETE_BATCH in models/file/file.orphan.model.js). Anything past this in a
 * single request is silently dropped server-side, so the client must chunk to it.
 */
export const ORPHAN_DELETE_BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Delete a whole selection regardless of size by splitting it into sequential
 * requests that each stay within ORPHAN_DELETE_BATCH_SIZE, then merging the
 * per-item outcomes into a single result. Sequential (not parallel) because each
 * entry drives per-object storage calls and cache invalidation on the server.
 *
 * @param onProgress - Called after each batch with entries processed so far and
 *   the total, so the caller can show real progress.
 */
export async function deleteOrphansInBatches(
  payload: { storageKeys?: string[]; fileIds?: string[]; graceMinutes: number },
  onProgress?: (done: number, total: number) => void
): Promise<OrphanDeleteResult> {
  const storageKeys = payload.storageKeys ?? [];
  const fileIds = payload.fileIds ?? [];
  const total = storageKeys.length + fileIds.length;

  const merged: OrphanDeleteResult = {
    graceMinutes: payload.graceMinutes,
    storage: { results: [], deleted: 0, skipped: 0 },
    database: { results: [], deleted: 0, skipped: 0 },
  };

  const keyBatches = chunk(storageKeys, ORPHAN_DELETE_BATCH_SIZE);
  const idBatches = chunk(fileIds, ORPHAN_DELETE_BATCH_SIZE);
  const batchCount = Math.max(keyBatches.length, idBatches.length);

  let done = 0;
  for (let i = 0; i < batchCount; i += 1) {
    const keys = keyBatches[i] ?? [];
    const ids = idBatches[i] ?? [];
    const result = await deleteOrphans({ storageKeys: keys, fileIds: ids, graceMinutes: payload.graceMinutes });

    merged.graceMinutes = result.graceMinutes;
    merged.storage.results.push(...result.storage.results);
    merged.storage.deleted += result.storage.deleted;
    merged.storage.skipped += result.storage.skipped;
    merged.database.results.push(...result.database.results);
    merged.database.deleted += result.database.deleted;
    merged.database.skipped += result.database.skipped;

    done += keys.length + ids.length;
    onProgress?.(done, total);
  }

  return merged;
}
