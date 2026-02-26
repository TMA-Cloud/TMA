export type FolderUploadEntry = {
  file: File;
  /** Relative path including the selected/dropped folder name. */
  relativePath: string;
};

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
  // readEntries returns batches until it returns empty array.
  while (true) {
    const batch: FileSystemEntryLike[] = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch || batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function traverseEntry(entry: FileSystemEntryLike, prefix: string): Promise<FolderUploadEntry[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file?.(resolve, reject);
    });
    return [{ file, relativePath: `${prefix}${file.name}` }];
  }

  if (entry.isDirectory) {
    const reader = entry.createReader?.();
    if (!reader) return [];
    const children = await readAllDirectoryEntries(reader);
    const results: FolderUploadEntry[] = [];
    for (const child of children) {
      const childResults = await traverseEntry(child, `${prefix}${entry.name}/`);
      results.push(...childResults);
    }
    return results;
  }

  return [];
}

export function entriesFromFileList(fileList: FileList): FolderUploadEntry[] {
  return Array.from(fileList).map(file => {
    const anyFile = file as File & { webkitRelativePath?: string };
    const relativePath =
      anyFile.webkitRelativePath && anyFile.webkitRelativePath.trim().length > 0
        ? anyFile.webkitRelativePath
        : file.name;
    return { file, relativePath };
  });
}

/**
 * Extracts files from drag-and-drop. When supported (Chromium),
 * preserves folder structure via `webkitGetAsEntry()`.
 */
export async function entriesFromDataTransfer(dt: DataTransfer): Promise<FolderUploadEntry[]> {
  const items = Array.from(dt.items || []);
  const webkitEntries = items
    .filter(i => i.kind === 'file')
    .map(getWebkitEntry)
    .filter((e): e is FileSystemEntryLike => e != null);

  if (webkitEntries.length > 0) {
    const results: FolderUploadEntry[] = [];
    for (const entry of webkitEntries) {
      const entryResults = await traverseEntry(entry, '');
      results.push(...entryResults);
    }
    return results;
  }

  // Fallback: no folder structure available.
  return Array.from(dt.files || []).map(file => ({ file, relativePath: file.name }));
}
