import { createSliceBudget, mapWithYield, runWithConcurrency, yieldToMain } from './scheduling';

export type FolderUploadEntry = {
  file: File;
  /** Relative path including the selected/dropped folder name. Omit for top-level files (e.g. dropped files). */
  relativePath?: string;
};

/**
 * Reports how far a scan has got. Counts are the files discovered so far.
 */
export type ScanOptions = {
  onProgress?: (scanned: number) => void;
  /** Abandons the walk — the user closed the modal or dropped something else. */
  signal?: AbortSignal;
};

/** Resolving a File from an entry is a round-trip each; a few at a time beats one at a time. */
const FILE_RESOLVE_CONCURRENCY = 16;

class ScanAbortedError extends Error {
  constructor() {
    super('Scan aborted');
    this.name = 'ScanAbortedError';
  }
}

export function isScanAborted(err: unknown): boolean {
  return err instanceof ScanAbortedError;
}

/**
 * Sends the file's own modification time alongside the bytes, so an upload reads
 * as the age of its contents not the moment it landed here.
 *
 * `lastModified` is the only timestamp the File API exposes — there is no birth
 * time to forward and it is epoch milliseconds in UTC, so nothing about the
 * uploader's timezone travels with it. The server treats it as unverified: it
 * clamps the value and falls back to the upload time when it is nonsense.
 */
export function appendClientMtime(data: FormData, file: File): void {
  const ms = file.lastModified;
  data.append('lastModifiedTimes', Number.isFinite(ms) ? String(Math.trunc(ms)) : '');
}

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (successCallback: (file: File) => void, errorCallback?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      successCallback: (entries: FileSystemEntryLike[]) => void,
      errorCallback?: (err: unknown) => void
    ) => void;
  };
};

function getWebkitEntry(item: DataTransferItem): FileSystemEntryLike | null {
  const anyItem = item as unknown as { webkitGetAsEntry?: () => FileSystemEntryLike | null };
  return typeof anyItem.webkitGetAsEntry === 'function' ? anyItem.webkitGetAsEntry() : null;
}

async function readAllDirectoryEntries(
  reader: NonNullable<FileSystemEntryLike['createReader']> extends () => infer R ? R : never
) {
  const all: FileSystemEntryLike[] = [];
  // Chromium hands back at most 100 entries per call, so a big directory needs
  // repeated reads; an empty batch is the only end-of-list signal.
  while (true) {
    const batch: FileSystemEntryLike[] = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch || batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

type PendingEntry = { entry: FileSystemEntryLike; prefix: string };

/**
 * Walks a set of dropped entries into a flat file list without blocking the UI.
 *
 * The walk is iterative rather than recursive for two reasons: a deep tree can
 * exhaust the stack, and an explicit stack is what lets us suspend mid-walk and
 * resume after yielding. Order is preserved as depth-first pre-order (children
 * pushed in reverse), so a folder's files still arrive together and the staged
 * list reads the way the user's folder looks.
 *
 * File objects are materialised in a second pass: `entry.file()` is an async
 * round-trip each, so resolving a bounded group at a time turns thousands of
 * serial hops into a handful of parallel ones.
 */
async function scanEntries(roots: FileSystemEntryLike[], options: ScanOptions): Promise<FolderUploadEntry[]> {
  const { onProgress, signal } = options;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new ScanAbortedError();
  };

  const fileEntries: { entry: FileSystemEntryLike; relativePath?: string }[] = [];
  const stack: PendingEntry[] = roots.map(entry => ({ entry, prefix: '' })).reverse();
  const budget = createSliceBudget();

  while (stack.length > 0) {
    throwIfAborted();
    const { entry, prefix } = stack.pop() as PendingEntry;

    if (entry.isFile) {
      // Only set relativePath when inside a dropped folder (prefix !== '') so the UI shows "Files to Upload" for top-level dropped files
      fileEntries.push({ entry, ...(prefix ? { relativePath: `${prefix}${entry.name}` } : {}) });
      onProgress?.(fileEntries.length);
    } else if (entry.isDirectory) {
      const reader = entry.createReader?.();
      if (reader) {
        const children = await readAllDirectoryEntries(reader);
        const childPrefix = `${prefix}${entry.name}/`;
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ entry: children[i] as FileSystemEntryLike, prefix: childPrefix });
        }
      }
    }

    if (budget.expired()) {
      await yieldToMain();
      budget.reset();
    }
  }

  throwIfAborted();

  const resolved = await runWithConcurrency(fileEntries, FILE_RESOLVE_CONCURRENCY, async ({ entry, relativePath }) => {
    throwIfAborted();
    const file = await new Promise<File>((resolve, reject) => {
      entry.file?.(resolve, reject);
    });
    // The entry name and the File name agree, but the File is the authority.
    const path = relativePath ? relativePath.replace(/[^/]+$/, file.name) : undefined;
    return { file, ...(path != null ? { relativePath: path } : {}) };
  });

  return resolved;
}

export function entriesFromFileList(fileList: FileList): FolderUploadEntry[] {
  return Array.from(fileList).map(toFolderUploadEntry);
}

function toFolderUploadEntry(file: File): FolderUploadEntry {
  const anyFile = file as File & { webkitRelativePath?: string };
  const relativePath =
    anyFile.webkitRelativePath && anyFile.webkitRelativePath.trim().length > 0 ? anyFile.webkitRelativePath : file.name;
  return { file, relativePath };
}

/**
 * Time-sliced form of {@link entriesFromFileList}. The per-file work is
 * trivial; it is doing it 50,000 times in one go that stalls the frame.
 */
export async function entriesFromFileListAsync(
  fileList: FileList,
  options: ScanOptions = {}
): Promise<FolderUploadEntry[]> {
  return stageFileList(fileList, toFolderUploadEntry, options);
}

/**
 * Time-sliced staging of loose files. No relative path is attached: these land
 * in the current folder, and claiming a path would make the UI read them as a
 * folder upload.
 */
export async function plainEntriesFromFileListAsync(
  fileList: FileList,
  options: ScanOptions = {}
): Promise<FolderUploadEntry[]> {
  return stageFileList(fileList, file => ({ file }), options);
}

async function stageFileList(
  fileList: FileList,
  transform: (file: File) => FolderUploadEntry,
  options: ScanOptions
): Promise<FolderUploadEntry[]> {
  const { onProgress, signal } = options;
  const entries = await mapWithYield(fileList, transform, done => {
    if (!signal?.aborted) onProgress?.(done);
  });
  if (signal?.aborted) throw new ScanAbortedError();
  return entries;
}

/**
 * Extracts files from drag-and-drop. When supported (Chromium),
 * preserves folder structure via `webkitGetAsEntry()`.
 */
export async function entriesFromDataTransfer(
  dt: DataTransfer,
  options: ScanOptions = {}
): Promise<FolderUploadEntry[]> {
  // webkitGetAsEntry is only valid synchronously during the drop event, so the
  // entries must be captured before the first await.
  const items = Array.from(dt.items || []);
  const webkitEntries = items
    .filter(i => i.kind === 'file')
    .map(getWebkitEntry)
    .filter((e): e is FileSystemEntryLike => e != null);

  if (webkitEntries.length > 0) {
    return scanEntries(webkitEntries, options);
  }

  // Fallback: no folder structure available; treat as plain files (no relativePath).
  const plain = Array.from(dt.files || []).map(file => ({ file }));
  options.onProgress?.(plain.length);
  return plain;
}
