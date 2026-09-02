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
  driver: 's3' | 'local';
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

export async function fetchOrphans(graceMinutes: number): Promise<OrphanReport> {
  return apiGet<OrphanReport>(`/api/user/orphans?graceMinutes=${encodeURIComponent(graceMinutes)}`);
}

export async function deleteOrphans(payload: {
  storageKeys?: string[];
  fileIds?: string[];
  graceMinutes: number;
}): Promise<OrphanDeleteResult> {
  return apiPost<OrphanDeleteResult>('/api/user/orphans/delete', payload);
}
