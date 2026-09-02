// Pure helpers for the upload modal: naming, folder grouping, and building the upload plan.

import type { FileItem } from '../../contexts/AppContext';

/** Cap on rows rendered: a huge folder would otherwise be tens of thousands of DOM nodes. */
export const MAX_VISIBLE_PENDING = 100;

export interface UploadFile {
  id: string;
  file: File;
  relativePath?: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
}

export interface FolderUploadGroup {
  id: string;
  name: string;
  totalSize: number;
  fileCount: number;
}

export interface UploadPlan {
  replaceItems: { fileId: string; file: File }[];
  newFiles: { file: File; relativePath?: string; clientId: string }[];
}

/** Returns a unique name like "name (1).ext" not in existingNames or usedInBatch. */
export function getUniqueUploadName(
  originalName: string,
  existingNames: Set<string>,
  usedInBatch: Set<string>
): string {
  const lastDot = originalName.lastIndexOf('.');
  const base = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
  const ext = lastDot > 0 ? originalName.slice(lastDot) : '';
  let n = 1;
  let candidate: string;
  do {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  } while (existingNames.has(candidate) || usedInBatch.has(candidate));
  return candidate;
}

/** The top-level folder a staged item belongs to, or the file name when loose. */
export function getRootFolderName(relativePath: string | undefined, fallbackName: string): string {
  if (!relativePath) return fallbackName;
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized) return fallbackName;
  const parts = normalized.split('/').filter(Boolean);
  return parts[0] || fallbackName;
}

/** Collapses a folder upload's files into one row per top-level folder. */
export function buildFolderUploadGroups(uploadFiles: UploadFile[]): FolderUploadGroup[] {
  const map = new Map<string, FolderUploadGroup>();

  for (const item of uploadFiles) {
    const rootName = getRootFolderName(item.relativePath, item.file.name);
    const existing = map.get(rootName);
    if (existing) {
      existing.totalSize += item.file.size;
      existing.fileCount += 1;
    } else {
      map.set(rootName, {
        id: rootName,
        name: rootName,
        totalSize: item.file.size,
        fileCount: 1,
      });
    }
  }

  return Array.from(map.values());
}

/** Build replace list and new-files list from current pending items and resolutions. */
export function buildUploadPlan(
  pendingItems: UploadFile[],
  existingFileNames: Set<string>,
  existingFileByName: Map<string, FileItem>,
  resolutions: Record<string, 'replace' | 'rename'>
): UploadPlan {
  const replaceItems: { fileId: string; file: File }[] = [];
  const usedInBatch = new Set(existingFileNames);
  const newFiles: { file: File; relativePath?: string; clientId: string }[] = [];

  for (const item of pendingItems) {
    const clientId = item.id;
    if (item.relativePath) {
      newFiles.push({ file: item.file, relativePath: item.relativePath, clientId });
      continue;
    }

    const choice = resolutions[item.id];
    if (!choice) {
      newFiles.push({ file: item.file, clientId });
      continue;
    }
    if (choice === 'replace') {
      const existing = existingFileByName.get(item.file.name);
      if (existing?.id) {
        replaceItems.push({ fileId: existing.id, file: item.file });
      } else {
        newFiles.push({ file: item.file, clientId });
      }
      continue;
    }
    if (choice === 'rename') {
      const newName = getUniqueUploadName(item.file.name, existingFileNames, usedInBatch);
      usedInBatch.add(newName);
      const type = item.file.type || 'application/octet-stream';
      const renamedFile = new (
        window as Window & { File: new (b: BlobPart[], n: string, o?: FilePropertyBag) => File }
      ).File([item.file], newName, { type, lastModified: Date.now() });
      newFiles.push({ file: renamedFile, clientId });
    }
  }
  return { replaceItems, newFiles };
}

/**
 * Preview name for "Upload with Renamed" — walks pending items in the same
 * order buildUploadPlan does so the previewed name matches what will be sent.
 */
export function computeRenamedPreview(
  uploadId: string,
  pendingItems: UploadFile[],
  duplicateChoices: Record<string, 'replace' | 'rename'>,
  existingFileNames: Set<string>
): string {
  if (duplicateChoices[uploadId] !== 'rename') return '';
  const usedInBatch = new Set(existingFileNames);
  for (const item of pendingItems) {
    if (duplicateChoices[item.id] !== 'rename') continue;
    const name = getUniqueUploadName(item.file.name, existingFileNames, usedInBatch);
    usedInBatch.add(name);
    if (item.id === uploadId) return name;
  }
  return '';
}
