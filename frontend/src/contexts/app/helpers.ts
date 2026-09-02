// Pure helpers shared by the AppProvider feature hooks.

import type { FileItem, FileSortBy } from '../AppContext';

// Navigation / paging

export const FILE_MANAGER_PAGES = new Set(['My Files', 'Shared', 'Starred', 'Trash']);

export const isFileManagerPage = (page: string | undefined) => !!page && FILE_MANAGER_PAGES.has(page);

// Sorting

const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

export function sortFilesWithFoldersFirst(
  items: FileItem[],
  sortBy: FileSortBy,
  sortOrder: 'asc' | 'desc'
): FileItem[] {
  const direction = sortOrder === 'desc' ? -1 : 1;

  const compareCore = (a: FileItem, b: FileItem): number => {
    const byName = () => naturalCompare(a.name, b.name);
    switch (sortBy) {
      case 'name':
        return byName();
      case 'size': {
        const diff = (a.size ?? 0) - (b.size ?? 0);
        return diff !== 0 ? (diff < 0 ? -1 : 1) : byName();
      }
      case 'deletedAt': {
        const diff = (a.deletedAt?.getTime() ?? 0) - (b.deletedAt?.getTime() ?? 0);
        return diff !== 0 ? (diff < 0 ? -1 : 1) : byName();
      }
      case 'accessedAt': {
        const diff = (a.accessedAt?.getTime() ?? 0) - (b.accessedAt?.getTime() ?? 0);
        return diff !== 0 ? (diff < 0 ? -1 : 1) : byName();
      }
      case 'modified':
      default: {
        const diff = (a.modified?.getTime() ?? 0) - (b.modified?.getTime() ?? 0);
        return diff !== 0 ? (diff < 0 ? -1 : 1) : byName();
      }
    }
  };

  return [...items].sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return compareCore(a, b) * direction;
  });
}

// Upload progress / batching

export const getInFlightUploadProgress = (loaded: number, total: number): number =>
  Math.min(Math.round((loaded / total) * 100), 99);

/** Bulk upload batching. */
export const BULK_BATCH_MAX_FILES = 100;
export const BULK_BATCH_MAX_BYTES = 64 * 1024 * 1024;
/** Kept below the browser's six-per-origin ceiling. */
export const BULK_BATCH_CONCURRENCY = 3;
/** Below this, per-file rows are informative. */
export const BULK_AGGREGATE_THRESHOLD = 8;
export const BULK_PROGRESS_THROTTLE_MS = 120;

/** True when the server refused the batch over what was in it, not over who sent it. */
export function isContentRejection(status: number): boolean {
  return status === 400 || status === 415;
}

/** Splits "Photos/2024/clip.mp4" into the folder it sat in, if any. */
export function folderPathOf(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const normalized = relativePath.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut > 0 ? normalized.slice(0, cut) : undefined;
}

export function splitIntoBatches<T extends { file: File }>(entries: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;

  for (const entry of entries) {
    const overflows = current.length >= BULK_BATCH_MAX_FILES || bytes + entry.file.size > BULK_BATCH_MAX_BYTES;
    if (current.length > 0 && overflows) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entry.file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Names the upload for the progress card: the folder if there is one, else a file count. */
export function describeBulkUpload(entries: { file: File; relativePath?: string }[]): string {
  const roots = new Set<string>();
  for (const entry of entries) {
    const normalized = (entry.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const root = normalized.split('/').filter(Boolean)[0];
    if (root && normalized.includes('/')) roots.add(root);
  }
  const countLabel = `${entries.length.toLocaleString()} files`;
  if (roots.size === 1) return `${[...roots][0]} — ${countLabel}`;
  if (roots.size > 1) return `${roots.size} folders — ${countLabel}`;
  return countLabel;
}

// Download

export function parseContentDispositionFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const rfc5987 = header.match(/filename\*=UTF-8''([^;,\s]+)/i);
  if (rfc5987?.[1]) {
    try {
      return decodeURIComponent(rfc5987[1]);
    } catch {
      return rfc5987[1];
    }
  }
  const quoted = header.match(/filename="([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  const unquoted = header.match(/filename=([^;,\s]+)/);
  return unquoted?.[1] ?? fallback;
}

// Shared internal types

export type NavEntry = { path: string[]; ids: (string | null)[]; shared: boolean[] };
export type ProgressState = { itemCount: number; percent: number; label: string };
