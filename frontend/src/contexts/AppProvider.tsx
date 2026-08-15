import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  AppContext,
  type BulkUploadEntry,
  type FileItem,
  type FileItemResponse,
  type FileSortBy,
  type ShareExpiry,
  type UploadModalInitialEntry,
} from './AppContext';
import { useAuth } from './AuthContext';
import { usePromiseQueue, useDebouncedCallback } from '../utils/debounce';
import {
  downloadFile as downloadFileApi,
  checkOnlyOfficeConfigured,
  getSignupStatus,
  hasAuthState,
  checkUploadStorage,
  getMaxUploadSizeConfig,
  getCurrentVersions,
  fetchLatestVersions,
  sendClientHeartbeat,
} from '../utils/api';
import { useToast } from '../hooks/useToast';
import { extractXhrErrorMessage, extractResponseError, ApiError } from '../utils/errorUtils';
import {
  removeUploadProgress,
  updateUploadProgress,
  createAutoDismissTimeout,
  type UploadProgressItem,
} from '../utils/uploadUtils';
import {
  isElectron,
  getFilesFromElectronClipboard,
  peekElectronClipboardFileNames,
  copyFilesToPcClipboard,
  MAX_COPY_TO_PC_BYTES,
  editFileWithDesktopElectron,
  saveFileViaElectron,
  saveFilesBulkViaElectron,
  getElectronAppVersion,
  downloadAndInstallElectronUpdate,
  subscribeToUpdateDownloadProgress,
} from '../utils/electronDesktop';
import { appendClientMtime } from '../utils/folderUpload';
import { runWithConcurrency, throttleTrailing } from '../utils/scheduling';
import { formatBytes } from '../utils/storageUtils';
import { mapFileResponse } from '../utils/fileUtils';

// Constants & Pure Helpers

const FILE_MANAGER_PAGES = new Set(['My Files', 'Shared', 'Starred', 'Trash']);

const isFileManagerPage = (page: string | undefined) => !!page && FILE_MANAGER_PAGES.has(page);

/** How long server events are coalesced before the list refreshes. */
const SSE_REFRESH_DEBOUNCE_MS = 800;
const SSE_REFRESH_MAX_WAIT_MS = 2500;

const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

const getInFlightUploadProgress = (loaded: number, total: number): number =>
  Math.min(Math.round((loaded / total) * 100), 99);

/**
 * Bulk upload batching.
 */
const BULK_BATCH_MAX_FILES = 100;
const BULK_BATCH_MAX_BYTES = 64 * 1024 * 1024;
/** Kept below the browser's six-per-origin ceiling. */
const BULK_BATCH_CONCURRENCY = 3;
/** Below this, per-file rows are informative. */
const BULK_AGGREGATE_THRESHOLD = 8;
const BULK_PROGRESS_THROTTLE_MS = 120;
/** A failed batch of hundreds must not become hundreds of toasts. */
const MAX_FAILURE_TOASTS = 3;

function splitIntoBatches<T extends { file: File }>(entries: T[]): T[][] {
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
function describeBulkUpload(entries: { file: File; relativePath?: string }[]): string {
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

function sortFilesWithFoldersFirst(items: FileItem[], sortBy: FileSortBy, sortOrder: 'asc' | 'desc'): FileItem[] {
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

function parseContentDispositionFilename(header: string | null, fallback: string): string {
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

// Types

type NavEntry = { path: string[]; ids: (string | null)[]; shared: boolean[] };
type ProgressState = { itemCount: number; percent: number; label: string };

// Provider

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { showToast } = useToast();
  const { user } = useAuth();

  // State

  const [currentPath, setCurrentPathState] = useState<string[]>(['My Files']);
  const [folderStack, setFolderStack] = useState<(string | null)[]>([null]);
  const [folderSharedStack, setFolderSharedStack] = useState<boolean[]>([false]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadModalProcessing, setUploadModalProcessing] = useState(false);
  const [uploadModalProcessingRequestId, setUploadModalProcessingRequestId] = useState<string | null>(null);
  const [uploadScanCount, setUploadScanCount] = useState(0);
  const [uploadModalInitialEntries, setUploadModalInitialEntries] = useState<UploadModalInitialEntry[] | null>(null);
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false);
  const [imageViewerFile, setImageViewerFile] = useState<FileItem | null>(null);
  const [documentViewerFile, setDocumentViewerFile] = useState<FileItem | null>(null);
  const [shareLinkModalOpen, setShareLinkModalOpenState] = useState(false);
  const [shareLinks, setShareLinks] = useState<string[]>([]);
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [clipboard, setClipboard] = useState<{ ids: string[]; action: 'copy' | 'cut' } | null>(null);
  /**
   * Names we last wrote to the OS clipboard during a unified Copy. Used at paste time to detect
   * whether the OS clipboard was overwritten externally (e.g. user copied a file in Explorer
   * after our Copy). null = we never synced, or we cleared because the cloud clipboard moved on.
   */
  const lastOsClipboardSyncRef = useRef<string[] | null>(null);
  // Anything other than a successful unified Copy (Cut, paste-clear, manual setClipboard) means
  // the OS sync no longer represents the current cloud clipboard — drop the tracker so paste
  // doesn't think they still match.
  useEffect(() => {
    if (!clipboard || clipboard.action !== 'copy') {
      lastOsClipboardSyncRef.current = null;
    }
  }, [clipboard]);
  const [pasteProgress, setPasteProgress] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<FileSortBy>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<ProgressState | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<ProgressState | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressItem[]>([]);
  const [isUploadProgressInteracting, setIsUploadProgressInteracting] = useState(false);
  const [onlyOfficeConfigured, setOnlyOfficeConfigured] = useState(false);
  const [canConfigureOnlyOffice, setCanConfigureOnlyOffice] = useState(false);
  const [hideFileExtensions, setHideFileExtensions] = useState(false);
  const [updatesAvailable, setUpdatesAvailable] = useState<{
    frontend?: string;
    backend?: string;
    electron?: string;
  } | null>(null);
  const [hasCheckedUpdates, setHasCheckedUpdates] = useState(false);
  const [electronAutoUpdateState, setElectronAutoUpdateState] = useState<{
    status: 'idle' | 'downloading' | 'installing' | 'done' | 'error';
    progress: number | null;
    error?: string;
  }>({ status: 'idle', progress: null });
  const [navHistory, setNavHistory] = useState<{ entries: NavEntry[]; index: number }>(() => ({
    entries: [{ path: ['My Files'], ids: [null], shared: [false] }],
    index: 0,
  }));
  const [desktopOpenProgress, setDesktopOpenProgress] = useState<
    { fileId: string; fileName: string; percent: number }[]
  >([]);

  // Refs

  const isUploadProgressInteractingRef = useRef(false);
  const uploadDismissTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const uploadXhrRef = useRef<Map<string, XMLHttpRequest>>(new Map());
  /** Every request belonging to a batched upload, so one Cancel stops all of them. */
  const uploadGroupRef = useRef<Map<string, { xhrs: Set<XMLHttpRequest>; cancelled: boolean }>>(new Map());
  const searchQueryRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const listRefreshControllerRef = useRef<AbortController | null>(null);
  const listRefreshSeqRef = useRef(0);
  const filesRef = useRef<FileItem[]>(files);
  const filesBeforeSearchRef = useRef<FileItem[] | null>(null);
  const didSavePreSearchRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseRefreshDeadlineRef = useRef<number | null>(null);
  const currentPathRef = useRef<string[]>(currentPath);
  const folderStackRef = useRef<(string | null)[]>(folderStack);
  const folderSharedStackRef = useRef<boolean[]>(folderSharedStack);
  const refreshFilesRef = useRef<((skipSearchCheck?: boolean) => Promise<void>) | null>(null);
  const returnHighlightAfterRefreshRef = useRef<string | null>(null);
  const desktopEditInProgressRef = useRef<Set<string>>(new Set());
  const deleteInProgressRef = useRef(false);
  const deleteProgressDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreInProgressRef = useRef(false);
  const restoreProgressDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadInProgressRef = useRef(false);
  const electronAutoUpdateTriggeredRef = useRef(false);

  const operationQueue = usePromiseQueue();

  // Ref-sync effects

  useEffect(() => {
    isUploadProgressInteractingRef.current = isUploadProgressInteracting;
  }, [isUploadProgressInteracting]);
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);
  useEffect(() => {
    folderStackRef.current = folderStack;
  }, [folderStack]);
  useEffect(() => {
    folderSharedStackRef.current = folderSharedStack;
  }, [folderSharedStack]);

  // Core data functions

  const refreshFiles = useCallback(
    async (skipSearchCheck = false) => {
      if (!skipSearchCheck && searchQuery.trim().length > 0) return;
      if (!isFileManagerPage(currentPath[0])) {
        returnHighlightAfterRefreshRef.current = null;
        return;
      }

      // Abort any prior in-flight listing and tag this request. A newer refresh
      // (fast navigation, post-mutation refresh, or SSE-triggered refresh) must
      // win so a slow response for an old folder can't overwrite the new one.
      listRefreshControllerRef.current?.abort();
      const controller = new AbortController();
      listRefreshControllerRef.current = controller;
      const requestId = ++listRefreshSeqRef.current;

      const parentId = folderStack[folderStack.length - 1];
      let urlPath = '/api/files';
      if (folderStack.length === 1) {
        if (currentPath[0] === 'Starred') urlPath = '/api/files/starred';
        else if (currentPath[0] === 'Shared') urlPath = '/api/files/shared';
        else if (currentPath[0] === 'Trash') urlPath = '/api/files/trash';
      }

      const url = new URL(urlPath, window.location.origin);
      if (parentId) url.searchParams.append('parentId', parentId);
      url.searchParams.append('sortBy', sortBy);
      if (sortOrder?.trim()) url.searchParams.append('order', sortOrder);

      try {
        const res = await fetch(url.toString(), {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
        const data: FileItemResponse[] = await res.json();

        // A newer refresh superseded this one while awaiting — discard the stale result.
        if (requestId !== listRefreshSeqRef.current) return;

        const sorted = sortFilesWithFoldersFirst(data.map(mapFileResponse), sortBy, sortOrder);
        setFiles(sorted);

        const highlightId = returnHighlightAfterRefreshRef.current;
        returnHighlightAfterRefreshRef.current = null;
        if (highlightId && sorted.some(f => f.id === highlightId)) {
          setSelectedFiles([highlightId]);
        }
      } catch (err) {
        // Aborted by a newer refresh: leave state and the pending highlight for the winner.
        if (err instanceof Error && err.name === 'AbortError') return;
        // Only the latest request should clear the pending highlight on failure.
        if (requestId === listRefreshSeqRef.current) {
          returnHighlightAfterRefreshRef.current = null;
        }
      } finally {
        if (listRefreshControllerRef.current === controller) {
          listRefreshControllerRef.current = null;
        }
      }
    },
    [folderStack, currentPath, sortBy, sortOrder, searchQuery]
  );

  const [debouncedRefreshFiles] = useDebouncedCallback((...args: unknown[]) => {
    void refreshFiles((args[0] as boolean | undefined) ?? false);
  }, 500);

  useEffect(() => {
    refreshFilesRef.current = refreshFiles;
  }, [refreshFiles]);

  const searchFilesApi = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (searchQueryRef.current.trim() !== trimmed) return;

      if (!trimmed) {
        setIsSearching(false);
        await refreshFiles(true);
        return;
      }

      if (abortControllerRef.current) abortControllerRef.current.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsSearching(true);
      try {
        const url = new URL('/api/files/search', window.location.origin);
        url.searchParams.append('q', trimmed);
        url.searchParams.append('limit', '100');

        const res = await fetch(url.toString(), {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: controller.signal,
        });

        if (controller.signal.aborted || searchQueryRef.current.trim() !== trimmed) return;
        if (!res.ok) throw new Error('Search failed');
        if (searchQueryRef.current.trim() !== trimmed) return;

        const data: FileItemResponse[] = await res.json();
        if (searchQueryRef.current.trim() !== trimmed) return;

        setFiles(sortFilesWithFoldersFirst(data.map(mapFileResponse), sortBy, sortOrder));
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
        if (searchQueryRef.current.trim() === trimmed && !controller.signal.aborted) {
          setFiles([]);
        }
      } finally {
        if (searchQueryRef.current.trim() === trimmed && abortControllerRef.current === controller) {
          setIsSearching(false);
          abortControllerRef.current = null;
        }
      }
    },
    [refreshFiles, sortBy, sortOrder]
  );

  const [debouncedSearch, cancelSearch] = useDebouncedCallback(
    ((query: string) => searchFilesApi(query)) as (...args: unknown[]) => unknown,
    300
  );

  // Internal helpers (use component scope, called only from event handlers)

  const validateUploadSize = async (filesToValidate: File[]) => {
    const { maxBytes } = await getMaxUploadSizeConfig();
    const oversized = filesToValidate.find(f => f.size > maxBytes);
    if (oversized) {
      const msg =
        filesToValidate.length === 1
          ? `This file is too large. Maximum upload size is ${formatBytes(maxBytes)}.`
          : `"${oversized.name}" is too large. Maximum upload size is ${formatBytes(maxBytes)}.`;
      showToast(msg, 'error');
      throw new Error(msg);
    }
    const totalSize = filesToValidate.reduce((sum, f) => sum + f.size, 0);
    try {
      await checkUploadStorage(totalSize);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Storage limit exceeded.';
      showToast(msg, 'error');
      throw e;
    }
  };

  const executeXhrUpload = (config: {
    url: string;
    formData: FormData;
    uploadId: string;
    fileName: string;
    fileSize: number;
    groupId?: string;
    onProgress?: (progress: number) => void;
  }): Promise<void> => {
    const { url, formData, uploadId, fileName, fileSize, groupId, onProgress } = config;
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      setUploadProgress(prev => [
        ...prev,
        {
          id: uploadId,
          fileName,
          fileSize,
          progress: 0,
          status: 'uploading' as const,
          ...(groupId ? { groupId } : {}),
        },
      ]);
      uploadXhrRef.current.set(uploadId, xhr);

      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          const progress = getInFlightUploadProgress(e.loaded, e.total);
          // When the browser upload reaches 99%, the XHR is often waiting on the backend
          // to finalize so we switch to a dedicated UI state instead of "99% stuck"
          const status: UploadProgressItem['status'] = progress >= 99 ? 'finalizing' : 'uploading';
          setUploadProgress(prev => updateUploadProgress(prev, uploadId, { progress, status }));
          onProgress?.(progress);
        }
      });

      const scheduleAutoDismiss = (isSuccess: boolean) => {
        const timeout = isSuccess
          ? createAutoDismissTimeout(
              uploadId,
              isUploadProgressInteractingRef,
              setUploadProgress,
              uploadDismissTimeoutsRef,
              3000,
              2000
            )
          : createAutoDismissTimeout(
              uploadId,
              isUploadProgressInteractingRef,
              setUploadProgress,
              uploadDismissTimeoutsRef
            );
        uploadDismissTimeoutsRef.current.set(uploadId, timeout);
      };

      const handleError = (fallbackMsg: string) => {
        setUploadProgress(prev => updateUploadProgress(prev, uploadId, { status: 'error' }));
        const errorMessage = extractXhrErrorMessage(xhr) || fallbackMsg;
        showToast(errorMessage, 'error');
        scheduleAutoDismiss(false);
        uploadXhrRef.current.delete(uploadId);
        reject(new Error(errorMessage));
      };

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadProgress(prev => updateUploadProgress(prev, uploadId, { progress: 100, status: 'completed' }));
          debouncedRefreshFiles(false);
          scheduleAutoDismiss(true);
          uploadXhrRef.current.delete(uploadId);
          resolve();
        } else {
          handleError('Upload failed');
        }
      });

      xhr.addEventListener('error', () => handleError('Upload failed. Please check your connection and try again.'));

      xhr.addEventListener('abort', () => {
        setUploadProgress(prev => removeUploadProgress(prev, uploadId));
        uploadXhrRef.current.delete(uploadId);
        reject(new Error('Upload cancelled'));
      });

      xhr.open('POST', url);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.send(formData);
    });
  };

  const runProgressOperation = async (opts: {
    ids: string[];
    lockRef: React.MutableRefObject<boolean>;
    dismissRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    setActive: (v: boolean) => void;
    setProgress: React.Dispatch<React.SetStateAction<ProgressState | null>>;
    actionLabel: string;
    finalizeLabel: string;
    url: string;
    onFetch?: (res: Response) => Promise<void>;
  }) => {
    const { ids, lockRef, dismissRef, setActive, setProgress, actionLabel, finalizeLabel, url, onFetch } = opts;

    if (lockRef.current) {
      throw new Error(`${actionLabel} already in progress. Please wait.`);
    }

    const itemCount = ids.length;
    const expectedMs = Math.min(30000, Math.max(3000, itemCount * 20));
    const startedAt = Date.now();

    lockRef.current = true;
    if (dismissRef.current) {
      clearTimeout(dismissRef.current);
      dismissRef.current = null;
    }
    setActive(true);
    setProgress({
      itemCount,
      percent: 5,
      label: itemCount === 1 ? `${actionLabel} 1 item...` : `${actionLabel} ${itemCount} items...`,
    });

    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const percent = Math.min(95, Math.max(5, Math.round((elapsed / expectedMs) * 90) + 5));
      setProgress(prev => (prev ? { ...prev, percent } : prev));
    }, 250);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ ids }),
      });

      if (onFetch) {
        await onFetch(res);
      } else if (!res.ok) {
        throw new Error(await extractResponseError(res));
      }

      clearInterval(timer);
      setProgress(prev => (prev ? { ...prev, percent: 100, label: `${finalizeLabel}...` } : prev));
      await refreshFiles();
      await new Promise(r => setTimeout(r, 450));
    } finally {
      clearInterval(timer);
      lockRef.current = false;
      setActive(false);
      dismissRef.current = setTimeout(() => {
        setProgress(null);
        dismissRef.current = null;
      }, 1500);
    }
  };

  const pushNavEntry = (path: string[], ids: (string | null)[], shared: boolean[]) => {
    setNavHistory(prev => {
      const cur = prev.entries[prev.index];
      if (cur && cur.path.length === path.length && JSON.stringify(cur.ids) === JSON.stringify(ids)) {
        return prev;
      }
      const base = prev.index < prev.entries.length - 1 ? prev.entries.slice(0, prev.index + 1) : prev.entries;
      return { entries: [...base, { path, ids, shared }], index: base.length };
    });
    setCurrentPathState(path);
    setFolderStack(ids);
    setFolderSharedStack(shared);
  };

  const refreshOrResearch = async () => {
    const activeQuery = searchQueryRef.current.trim();
    if (activeQuery) {
      await searchFilesApi(activeQuery);
    } else {
      await refreshFiles();
    }
  };

  // Upload dismiss effect

  useEffect(() => {
    if (!isUploadProgressInteracting) {
      const checkTimeout = setTimeout(() => {
        if (!isUploadProgressInteractingRef.current) {
          setUploadProgress(prev =>
            prev.filter(item => {
              if (item.status === 'completed' || item.status === 'error') {
                const t = uploadDismissTimeoutsRef.current.get(item.id);
                if (t) {
                  clearTimeout(t);
                  uploadDismissTimeoutsRef.current.delete(item.id);
                }
                return false;
              }
              return true;
            })
          );
        }
      }, 2000);
      return () => clearTimeout(checkTimeout);
    } else {
      uploadDismissTimeoutsRef.current.forEach(t => clearTimeout(t));
      uploadDismissTimeoutsRef.current.clear();
    }
  }, [isUploadProgressInteracting]);

  // Search effect

  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      if (!didSavePreSearchRef.current) {
        filesBeforeSearchRef.current = filesRef.current;
        didSavePreSearchRef.current = true;
      }
      debouncedSearch(searchQuery);
    } else {
      cancelSearch();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      Promise.resolve().then(() => {
        setIsSearching(false);
        if (!isFileManagerPage(currentPathRef.current[0]) && filesBeforeSearchRef.current) {
          setFiles(filesBeforeSearchRef.current);
        } else {
          void refreshFiles(true);
        }
        filesBeforeSearchRef.current = null;
        didSavePreSearchRef.current = false;
      });
    }
  }, [searchQuery, debouncedSearch, cancelSearch, refreshFiles]);

  // Electron derived upload status

  useEffect(() => {
    if (!isElectron()) return;
    const filesApi = window.electronAPI?.files;
    if (!filesApi?.onDerivedUploadStatus) return;

    const unsubscribe = filesApi.onDerivedUploadStatus(
      (payload: {
        state: 'started' | 'completed' | 'error';
        fileName: string;
        size?: number;
        originalId?: string;
        error?: string;
      }) => {
        const truncate = (name: string, max = 65): string => {
          if (!name || name.length <= max) return name;
          const dots = '......';
          const extIdx = name.lastIndexOf('.');
          const ext = extIdx > 0 && extIdx < name.length - 1 ? name.slice(extIdx) : '';
          const baseMax = max - dots.length - ext.length;
          return baseMax <= 0 ? name.slice(0, max - dots.length) + dots : `${name.slice(0, baseMax)}${dots}${ext}`;
        };
        const display = truncate(payload.fileName);

        if (payload.state === 'started') {
          const size = payload.size != null ? ` (${formatBytes(payload.size)})` : '';
          showToast(`Saving "${display}"${size}`, 'info');
        } else if (payload.state === 'completed') {
          showToast(`Exported "${display}"`, 'success');
          debouncedRefreshFiles(true);
        } else if (payload.state === 'error') {
          showToast(payload.error || `Failed to save "${display}"`, 'error');
        }
      }
    );

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [debouncedRefreshFiles, showToast]);

  // SSE (Server-Sent Events) for real-time updates

  const isEventRelevant = (
    eventType: string,
    eventData: { parentId?: string | null; id?: string; starred?: boolean; shared?: boolean }
  ) => {
    const page = currentPathRef.current[0];
    const parentId = folderStackRef.current[folderStackRef.current.length - 1];

    if (page === 'Starred') return eventData.starred !== undefined;
    if (page === 'Shared') return eventData.shared !== undefined;
    if (page === 'Trash') {
      return eventType === 'file.deleted' || eventType === 'file.restored' || eventType === 'file.permanently_deleted';
    }
    if (page === 'My Files') {
      return !parentId ? !eventData.parentId : eventData.parentId === parentId;
    }
    return true;
  };

  /**
   * Coalesces server events into a list refresh.
   */
  const debouncedSSERefresh = () => {
    const now = Date.now();
    if (sseRefreshDeadlineRef.current === null) {
      sseRefreshDeadlineRef.current = now + SSE_REFRESH_MAX_WAIT_MS;
    }

    const runRefresh = () => {
      sseRefreshTimeoutRef.current = null;
      sseRefreshDeadlineRef.current = null;
      refreshFilesRef.current?.(true);
    };

    if (sseRefreshTimeoutRef.current) clearTimeout(sseRefreshTimeoutRef.current);
    const wait = Math.max(0, Math.min(SSE_REFRESH_DEBOUNCE_MS, sseRefreshDeadlineRef.current - now));
    sseRefreshTimeoutRef.current = setTimeout(runRefresh, wait);
  };

  useEffect(() => {
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const eventSource = new EventSource('/api/files/events', { withCredentials: true });

      eventSource.onmessage = event => {
        // Successful message resets backoff
        reconnectAttempts = 0;
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
          const data = parsed as Record<string, unknown>;
          if (typeof data.type !== 'string') return;
          if (data.type === 'connected' || data.type === 'error') return;
          if (typeof data.data !== 'object' || data.data === null || Array.isArray(data.data)) return;
          const eventPayload = data.data as {
            parentId?: string | null;
            id?: string;
            starred?: boolean;
            shared?: boolean;
          };
          if (isEventRelevant(data.type, eventPayload)) {
            debouncedSSERefresh();
          }
        } catch (error) {
          if (import.meta.env.DEV) {
            console.error('[SSE] Error parsing event:', error, event.data);
          }
        }
      };

      eventSource.onerror = () => {
        // Close the broken connection to prevent the browser's default rapid reconnect
        eventSource.close();
        eventSourceRef.current = null;
        if (stopped) return;

        reconnectAttempts++;
        // Exponential backoff: 1s, 2s, 4s, 8s, … capped at 30s
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
        reconnectTimer = setTimeout(connect, delay);
      };

      eventSourceRef.current = eventSource;
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sseRefreshTimeoutRef.current) {
        clearTimeout(sseRefreshTimeoutRef.current);
        sseRefreshTimeoutRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  // Refresh files when navigating or changing sort (non-search)
  useEffect(() => {
    if (searchQuery.trim().length === 0 && isFileManagerPage(currentPath[0])) {
      Promise.resolve().then(() => refreshFiles(true));
    }
  }, [folderStack, currentPath, sortBy, sortOrder, searchQuery, refreshFiles]);

  // File Operations

  const createFolder = async (name: string) => {
    const res = await fetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ name, parentId: folderStack[folderStack.length - 1] }),
    });
    if (!res.ok) throw new Error(await extractResponseError(res));
    await refreshFiles();
  };

  const uploadFile = async (file: File) => {
    return operationQueue.add(async () => {
      await validateUploadSize([file]);
      const data = new FormData();
      const parentId = folderStack[folderStack.length - 1];
      if (parentId) data.append('parentId', parentId);
      data.append('file', file);
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: data,
      });
      if (!res.ok) throw new Error(await extractResponseError(res));
      await refreshFiles();
    });
  };

  const uploadFilesBulk = async (filesToUpload: File[]) => {
    return uploadEntriesBulk(filesToUpload.map(file => ({ file })));
  };

  /**
   * Uploads a set of files as a sequence of bounded batches.
   */
  const uploadEntriesBulk = async (entries: BulkUploadEntry[]) => {
    if (entries.length === 0) return;

    return operationQueue.add(async () => {
      await validateUploadSize(entries.map(e => e.file));

      const parentId = folderStack[folderStack.length - 1];
      const hasRelativePaths = entries.some(e => e.relativePath);

      // A handful of loose files keeps the per-file path: a row each and
      // independent cancellation are worth more than batching at that size.
      if (!hasRelativePaths && entries.length <= BULK_AGGREGATE_THRESHOLD) {
        await runWithConcurrency(entries, BULK_BATCH_CONCURRENCY, (entry, index) => {
          const clientId = entry.clientId || `file-${Date.now()}-${index}`;
          const formData = new FormData();
          if (parentId) formData.append('parentId', parentId);
          formData.append('files', entry.file);
          formData.append('clientIds', clientId);
          appendClientMtime(formData, entry.file);

          return executeXhrUpload({
            url: '/api/files/upload/bulk',
            formData,
            uploadId: clientId,
            fileName: entry.file.name,
            fileSize: entry.file.size,
          });
        });
        return;
      }

      const groupId = `bulk-${Date.now()}-${Math.random()}`;
      const aggregateId = `${groupId}-all`;
      const normalized = entries.map((entry, i) => ({
        file: entry.file,
        clientId: entry.clientId || `${groupId}-${i}`,
        relativePath: entry.relativePath || '',
      }));
      const totalBytes = Math.max(
        1,
        normalized.reduce((sum, e) => sum + e.file.size, 0)
      );
      const batches = splitIntoBatches(normalized);

      const group = { xhrs: new Set<XMLHttpRequest>(), cancelled: false };
      uploadGroupRef.current.set(groupId, group);
      uploadGroupRef.current.set(aggregateId, group);

      setUploadProgress(prev => [
        ...prev,
        {
          id: aggregateId,
          fileName: describeBulkUpload(normalized),
          fileSize: totalBytes,
          progress: 0,
          status: 'uploading' as const,
          groupId,
        },
      ]);

      const sentBytes = new Array<number>(batches.length).fill(0);
      let completedFiles = 0;
      let failedFiles = 0;
      let toastedFailures = 0;
      let settled = false;

      const publishProgress = throttleTrailing(() => {
        if (settled) return;
        const loaded = sentBytes.reduce((sum, n) => sum + n, 0);
        const progress = getInFlightUploadProgress(loaded, totalBytes);
        // Bytes leave the browser well before the server has written them, so
        // the tail of the run is server time; say so rather than sit at 99%.
        const status: UploadProgressItem['status'] = progress >= 99 ? 'finalizing' : 'uploading';
        setUploadProgress(prev => updateUploadProgress(prev, aggregateId, { progress, status }));
      }, BULK_PROGRESS_THROTTLE_MS);

      const scheduleAggregateDismiss = (isSuccess: boolean) => {
        const timeout = isSuccess
          ? createAutoDismissTimeout(
              aggregateId,
              isUploadProgressInteractingRef,
              setUploadProgress,
              uploadDismissTimeoutsRef,
              3000,
              2000
            )
          : createAutoDismissTimeout(
              aggregateId,
              isUploadProgressInteractingRef,
              setUploadProgress,
              uploadDismissTimeoutsRef
            );
        uploadDismissTimeoutsRef.current.set(aggregateId, timeout);
      };

      const sendBatch = (batch: typeof normalized, batchIndex: number) =>
        new Promise<void>((resolve, reject) => {
          if (group.cancelled) {
            resolve();
            return;
          }

          const batchBytes = batch.reduce((sum, e) => sum + e.file.size, 0);
          const data = new FormData();
          if (parentId) data.append('parentId', parentId);
          batch.forEach(entry => {
            data.append('files', entry.file);
            data.append('relativePaths', entry.relativePath);
            data.append('clientIds', entry.clientId);
            appendClientMtime(data, entry.file);
          });

          const xhr = new XMLHttpRequest();
          group.xhrs.add(xhr);
          const release = () => group.xhrs.delete(xhr);

          xhr.upload.addEventListener('progress', e => {
            if (!e.lengthComputable || e.total === 0) return;
            // Scale against the batch's file bytes: the multipart envelope
            // inflates e.total, and the aggregate bar is drawn from file sizes.
            sentBytes[batchIndex] = Math.min(batchBytes, (e.loaded / e.total) * batchBytes);
            publishProgress();
          });

          xhr.addEventListener('load', () => {
            release();
            if (xhr.status < 200 || xhr.status >= 300) {
              reject(new Error(extractXhrErrorMessage(xhr) || 'Failed to upload files'));
              return;
            }

            sentBytes[batchIndex] = batchBytes;
            let succeeded = batch.length;
            let failures: { fileName: string; error: string }[] = [];
            try {
              const response = JSON.parse(xhr.responseText);
              if (Array.isArray(response?.files)) succeeded = response.files.length;
              if (Array.isArray(response?.failed)) failures = response.failed;
            } catch {
              // Unparseable body on a 2xx: count the batch as delivered.
            }

            completedFiles += succeeded;
            failedFiles += failures.length;
            failures.slice(0, Math.max(0, MAX_FAILURE_TOASTS - toastedFailures)).forEach(f => {
              toastedFailures += 1;
              showToast(`Failed to upload ${f.fileName}: ${f.error}`, 'error');
            });

            publishProgress();
            // Each landed batch is real, visible progress in the file list.
            debouncedRefreshFiles(false);
            resolve();
          });

          xhr.addEventListener('error', () => {
            release();
            reject(
              new Error(extractXhrErrorMessage(xhr) || 'Upload failed. Please check your connection and try again.')
            );
          });

          // A cancelled group tears its own progress card down; an aborted
          // batch here is that teardown, not a failure to report.
          xhr.addEventListener('abort', () => {
            release();
            resolve();
          });

          xhr.open('POST', '/api/files/upload/bulk');
          xhr.withCredentials = true;
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          xhr.send(data);
        });

      try {
        if (hasRelativePaths) {
          for (let i = 0; i < batches.length; i++) {
            if (group.cancelled) break;
            await sendBatch(batches[i] as typeof normalized, i);
          }
        } else {
          await runWithConcurrency(batches, BULK_BATCH_CONCURRENCY, (batch, i) =>
            group.cancelled ? Promise.resolve() : sendBatch(batch, i)
          );
        }

        settled = true;
        if (group.cancelled) return;

        const allFailed = completedFiles === 0 && failedFiles > 0;
        setUploadProgress(prev =>
          updateUploadProgress(prev, aggregateId, {
            progress: 100,
            status: allFailed ? 'error' : 'completed',
          })
        );
        if (failedFiles > 0) {
          showToast(
            `${completedFiles.toLocaleString()} uploaded, ${failedFiles.toLocaleString()} failed`,
            allFailed ? 'error' : 'info'
          );
        }
        scheduleAggregateDismiss(!allFailed);
        debouncedRefreshFiles(false);
      } catch (err) {
        settled = true;
        setUploadProgress(prev => updateUploadProgress(prev, aggregateId, { status: 'error' }));
        showToast(err instanceof Error ? err.message : 'Failed to upload files', 'error');
        scheduleAggregateDismiss(false);
        debouncedRefreshFiles(false);
        throw err;
      } finally {
        group.xhrs.forEach(xhr => xhr.abort());
        uploadGroupRef.current.delete(groupId);
        uploadGroupRef.current.delete(aggregateId);
      }
    });
  };

  /**
   * Unified copy. Algorithm:
   *   1. Set cloud clipboard immediately so an in-app paste works without waiting for any fetch.
   *   2. In Electron, if the selection contains regular files that fit within MAX_COPY_TO_PC_BYTES,
   *      kick off an OS-clipboard sync in the background so the user can also paste in Explorer.
   *      Folders, oversized files, and non-Electron environments fall back to cloud-only silently.
   *   3. Toast describes what actually happened (cloud-only, both, or both with a folders note).
   */
  const clipboardCopy = (ids: string[]) => {
    if (ids.length === 0) return;

    setClipboard({ ids, action: 'copy' });
    // Reset tracker — populated below only if we actually sync to the OS clipboard.
    lastOsClipboardSyncRef.current = null;

    const itemCount = ids.length;
    const itemLabel = `${itemCount} item${itemCount !== 1 ? 's' : ''}`;

    if (!isElectron()) {
      showToast(`Copied ${itemLabel}`, 'success');
      return;
    }

    const fileItems = ids
      .map(id => files.find(f => f.id === id))
      .filter((f): f is FileItem => f != null && String(f.type || '').toLowerCase() !== 'folder');
    const folderCount = itemCount - fileItems.length;
    const totalBytes = fileItems.reduce((s, f) => s + Number(f.size ?? 0), 0);
    const overLimit =
      fileItems.some(f => f.size != null && Number(f.size) > MAX_COPY_TO_PC_BYTES) || totalBytes > MAX_COPY_TO_PC_BYTES;

    if (fileItems.length === 0) {
      // Folders only — cloud paste only.
      showToast(`Copied ${itemLabel} (folders paste in cloud only)`, 'success');
      return;
    }
    if (overLimit) {
      showToast(`Copied ${itemLabel} (over 200 MB — paste in cloud only)`, 'success');
      return;
    }

    const items = fileItems.map(f => ({ id: f.id, name: f.name }));
    copyFilesToPcClipboard(items)
      .then(result => {
        if (result.ok) {
          // Remember which names we put on the OS clipboard so a later paste can detect
          // whether the OS clipboard was overwritten externally.
          lastOsClipboardSyncRef.current = items.map(i => i.name);
          const folderNote =
            folderCount > 0 ? ` (${folderCount} folder${folderCount !== 1 ? 's' : ''} cloud-only)` : '';
          showToast(`Copied ${itemLabel}${folderNote} — paste in cloud or in Explorer`, 'success');
        } else {
          showToast(`Copied ${itemLabel} (system clipboard unavailable — paste in cloud)`, 'success');
        }
      })
      .catch(() => {
        showToast(`Copied ${itemLabel} (system clipboard error — paste in cloud)`, 'success');
      });
  };

  const editFileWithDesktop = async (id: string) => {
    if (desktopEditInProgressRef.current.has(id)) {
      showToast('Already opening this file…', 'info');
      return;
    }

    const file = files.find(f => f.id === id);
    if (!file || String(file.type || '').toLowerCase() === 'folder') {
      showToast('Select one file to open on desktop', 'error');
      return;
    }
    if (!file.mimeType) {
      showToast("Can't open on desktop — unknown file type", 'error');
      return;
    }

    desktopEditInProgressRef.current.add(id);
    const isLarge = Number(file.size ?? 0) >= 50 * 1024 * 1024;
    let succeeded = false;
    const BASE_DURATION = isLarge ? 20000 : 8000;
    const MAX_PERCENT = 90;
    const TICK = 300;
    const startTime = Date.now();

    setDesktopOpenProgress(prev => {
      const base = { fileId: file.id, fileName: file.name, percent: 5 };
      const idx = prev.findIndex(p => p.fileId === file.id);
      if (idx === -1) return [...prev, base];
      const next = [...prev];
      next[idx] = base;
      return next;
    });

    const tick = () => {
      if (!desktopEditInProgressRef.current.has(id)) return;
      const percent = Math.max(
        5,
        Math.min(MAX_PERCENT, Math.round(((Date.now() - startTime) / BASE_DURATION) * MAX_PERCENT))
      );
      setDesktopOpenProgress(prev => {
        const idx = prev.findIndex(p => p.fileId === file.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx]!, percent };
        return next;
      });
      if (percent < MAX_PERCENT) setTimeout(tick, TICK);
    };
    setTimeout(tick, TICK);

    try {
      const result = await editFileWithDesktopElectron({ id: file.id, name: file.name });
      if (!result.ok) {
        showToast(result.error ?? 'Failed to open file on desktop', 'error');
        return;
      }

      succeeded = true;
      setDesktopOpenProgress(prev => {
        const idx = prev.findIndex(p => p.fileId === file.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx]!, percent: 100 };
        return next;
      });
      setTimeout(() => setDesktopOpenProgress(prev => prev.filter(p => p.fileId !== file.id)), 800);
      showToast('Opened on desktop — changes sync back automatically', 'success');
    } finally {
      desktopEditInProgressRef.current.delete(id);
      if (!succeeded) {
        setDesktopOpenProgress(prev => prev.filter(p => p.fileId !== file.id));
      }
    }
  };

  const uploadFileWithProgress = async (file: File, onProgress?: (progress: number) => void) => {
    return operationQueue.add(async () => {
      await validateUploadSize([file]);
      const formData = new FormData();
      const parentId = folderStack[folderStack.length - 1];
      if (parentId) formData.append('parentId', parentId);
      formData.append('file', file);
      appendClientMtime(formData, file);
      return executeXhrUpload({
        url: '/api/files/upload',
        formData,
        uploadId: `${Date.now()}-${Math.random()}`,
        fileName: file.name,
        fileSize: file.size,
        onProgress,
      });
    });
  };

  const replaceFileWithProgress = async (fileId: string, file: File, onProgress?: (progress: number) => void) => {
    return operationQueue.add(async () => {
      await validateUploadSize([file]);
      const formData = new FormData();
      formData.append('file', file);
      appendClientMtime(formData, file);
      return executeXhrUpload({
        url: `/api/files/${fileId}/replace`,
        formData,
        uploadId: `${Date.now()}-${Math.random()}`,
        fileName: file.name,
        fileSize: file.size,
        onProgress,
      });
    });
  };

  const moveFiles = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      const res = await fetch('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ ids, parentId }),
      });
      if (!res.ok) throw new Error(await extractResponseError(res));
      await refreshFiles();
    });
  };

  const copyFilesApi = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      const res = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ ids, parentId }),
      });
      if (!res.ok) throw new Error(await extractResponseError(res));
      await refreshFiles();
    });
  };

  const renameFileApi = async (id: string, name: string) => {
    const res = await fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ id, name }),
    });

    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      showToast(errorMessage || 'Failed to rename item', 'error');
      throw new Error(errorMessage || 'Failed to rename item');
    }

    try {
      const updated: FileItemResponse = await res.json();
      showToast(`Renamed to "${updated.name || name}"`, 'success');
    } catch {
      showToast('Item renamed', 'success');
    }

    await refreshFiles();
  };

  const shareFilesApi = async (
    ids: string[],
    shared: boolean,
    expiry?: ShareExpiry
  ): Promise<Record<string, string>> => {
    const res = await fetch('/api/files/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids, shared, ...(shared && expiry ? { expiry } : {}) }),
    });
    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      throw new Error(errorMessage || 'Failed to share files');
    }
    const data = await res.json();
    await refreshOrResearch();
    return data?.links || {};
  };

  const getShareLinks = async (ids: string[]): Promise<Record<string, string>> => {
    const res = await fetch('/api/files/share/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error('Failed to get share links');
    const data = await res.json();
    return data?.links || {};
  };

  const starFilesApi = async (ids: string[], starred: boolean) => {
    const res = await fetch('/api/files/star', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids, starred }),
    });
    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      throw new Error(errorMessage || 'Failed to update star status');
    }
    await refreshOrResearch();
  };

  const deleteFilesApi = async (ids: string[]) => {
    if (!ids.length) return;
    await runProgressOperation({
      ids,
      lockRef: deleteInProgressRef,
      dismissRef: deleteProgressDismissTimeoutRef,
      setActive: setIsDeleting,
      setProgress: setDeleteProgress,
      actionLabel: 'Deleting',
      finalizeLabel: 'Finalizing delete',
      url: '/api/files/delete',
    });
  };

  const restoreFilesApi = async (ids: string[]) => {
    if (!ids.length) return { success: true } as const;
    type RestoreResponse = { success: boolean; message?: string };
    let result: RestoreResponse | null = null;
    await runProgressOperation({
      ids,
      lockRef: restoreInProgressRef,
      dismissRef: restoreProgressDismissTimeoutRef,
      setActive: setIsRestoring,
      setProgress: setRestoreProgress,
      actionLabel: 'Restoring',
      finalizeLabel: 'Finalizing restore',
      url: '/api/files/trash/restore',
      onFetch: async res => {
        const data: unknown = await res.json();
        if (!res.ok) {
          const message =
            typeof (data as { message?: unknown }).message === 'string'
              ? ((data as { message?: unknown }).message as string)
              : undefined;
          throw new Error(message ?? 'Failed to restore files');
        }

        // Best-effort typing: backend should return `{ success: boolean, message?: string }`
        if (data && typeof data === 'object' && typeof (data as { success?: unknown }).success === 'boolean') {
          const success = (data as { success: boolean }).success;
          const message =
            typeof (data as { message?: unknown }).message === 'string'
              ? ((data as { message?: unknown }).message as string)
              : undefined;
          result = { success, ...(message ? { message } : {}) };
          return;
        }

        result = { success: false, message: 'Unexpected restore response from server.' };
      },
    });
    return result ?? { success: false, message: 'Restore did not return a response.' };
  };

  const deleteForeverApi = async (ids: string[]) => {
    if (!ids.length) return;
    await runProgressOperation({
      ids,
      lockRef: deleteInProgressRef,
      dismissRef: deleteProgressDismissTimeoutRef,
      setActive: setIsDeleting,
      setProgress: setDeleteProgress,
      actionLabel: 'Permanently deleting',
      finalizeLabel: 'Finalizing delete',
      url: '/api/files/trash/delete',
    });
  };

  const emptyTrashApi = async () => {
    const res = await fetch('/api/files/trash/empty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && typeof data.message === 'string' && data.message) || 'Failed to empty trash');
    }
    const data = await res.json();
    await refreshFiles();
    return data;
  };

  const linkToParentShareApi = async (ids: string[]): Promise<Record<string, string>> => {
    const res = await fetch('/api/files/link-parent-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error('Failed to link to parent share');
    const data = await res.json();
    await refreshFiles();
    return data?.links || {};
  };

  const pasteClipboard = async (parentId: string | null) => {
    if (!clipboard) return;

    return operationQueue.add(async () => {
      setPasteProgress(0);
      const endpoint = clipboard.action === 'cut' ? 'move' : 'copy';

      try {
        const res = await fetch(`/api/files/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
          body: JSON.stringify({ ids: clipboard.ids, parentId }),
        });

        if (!res.ok) {
          const errorMessage = await extractResponseError(res);
          throw new Error(
            errorMessage || (clipboard.action === 'cut' ? 'Failed to move files' : 'Failed to copy files')
          );
        }

        setPasteProgress(100);
        await refreshFiles();
        setClipboard(null);
        setTimeout(() => setPasteProgress(null), 300);
      } catch (error) {
        setPasteProgress(null);
        throw error;
      }
    });
  };

  /**
   * Unified paste. Cloud clipboard takes priority: if it's set, the user just copied/cut inside
   * the app, so we paste from cloud (no re-upload of bytes we already have). Only when the cloud
   * clipboard is empty do we fall back to uploading whatever's on the OS clipboard — that's the
   * "I copied a file in Explorer" case.
   */
  const clipboardPaste = async (parentId: string | null) => {
    // No cloud clipboard: only the OS clipboard matters.
    if (!clipboard) {
      if (!isElectron()) {
        showToast('Nothing to paste', 'info');
        return;
      }
      const clipFiles = await getFilesFromElectronClipboard();
      if (clipFiles.length === 0) {
        showToast('Nothing to paste', 'info');
        return;
      }
      await uploadFilesBulk(clipFiles);
      return;
    }

    // Cloud clipboard is set. Before defaulting to cloud paste, check whether the OS clipboard
    // was overwritten externally since our last sync — if so, the user's most recent intent is
    // the OS clipboard and we should upload that instead.
    //
    // Cut is exempt: the OS clipboard is never synced for a cut, so any files there are leftovers
    // from an earlier Copy/Explorer action and unrelated to the cut the user wants to complete.
    if (isElectron() && clipboard.action === 'copy') {
      const osNames = await peekElectronClipboardFileNames();
      const synced = lastOsClipboardSyncRef.current;
      const osHasFiles = osNames.length > 0;
      const matchesSync =
        synced != null &&
        osNames.length === synced.length &&
        new Set(synced).size === synced.length &&
        osNames.every(n => synced.includes(n));

      if (osHasFiles && !matchesSync) {
        // OS clipboard was set after our cloud copy (or we never synced). Treat as external paste.
        const clipFiles = await getFilesFromElectronClipboard();
        if (clipFiles.length > 0) {
          // Drop the now-stale cloud clipboard so subsequent pastes don't re-trigger this branch.
          setClipboard(null);
          await uploadFilesBulk(clipFiles);
          return;
        }
        // Peek saw names but readFiles returned nothing (race / unreadable format). Fall through
        // to cloud paste rather than failing silently.
      }
    }

    await pasteClipboard(parentId);
  };

  // Navigation

  const setCurrentPath = (path: string[], ids?: (string | null)[]) => {
    if (searchQuery.trim().length > 0) setSearchQuery('');
    pushNavEntry(path, ids ?? Array(path.length).fill(null), Array(path.length).fill(false));
  };

  const openFolder = (folder: FileItem) => {
    if (searchQuery.trim().length > 0) setSearchQuery('');
    pushNavEntry(
      [...currentPathRef.current, folder.name],
      [...folderStackRef.current, folder.id],
      [...folderSharedStackRef.current, !!folder.shared]
    );
  };

  const navigateTo = (index: number) => {
    const stackBefore = folderStackRef.current;
    const pathBefore = currentPathRef.current;
    const nextPath = pathBefore.slice(0, index + 1);
    const nextIds = stackBefore.slice(0, index + 1);
    const nextShared = folderSharedStackRef.current.slice(0, index + 1);
    if (nextPath.length === pathBefore.length && JSON.stringify(nextIds) === JSON.stringify(stackBefore)) {
      return;
    }
    if (searchQuery.trim().length > 0) setSearchQuery('');
    const newLen = index + 1;
    const highlightId = stackBefore.length > newLen && stackBefore[newLen] != null ? stackBefore[newLen]! : null;
    returnHighlightAfterRefreshRef.current = highlightId;
    setSelectedFiles([]);
    pushNavEntry(nextPath, nextIds, nextShared);
  };

  const canGoBack = navHistory.index > 0;
  const canGoForward = navHistory.index < navHistory.entries.length - 1;

  const goBack = () => {
    if (!canGoBack) return;
    if (searchQuery.trim().length > 0) setSearchQuery('');
    const stackBefore = folderStackRef.current;
    const entry = navHistory.entries[navHistory.index - 1];
    if (!entry) return;
    const highlightId =
      stackBefore.length > entry.path.length && stackBefore[entry.path.length] != null
        ? stackBefore[entry.path.length]!
        : null;
    returnHighlightAfterRefreshRef.current = highlightId;
    setSelectedFiles([]);
    setNavHistory(prev => ({ ...prev, index: prev.index - 1 }));
    setCurrentPathState(entry.path);
    setFolderStack(entry.ids);
    setFolderSharedStack(entry.shared);
  };

  const goForward = () => {
    if (!canGoForward) return;
    const entry = navHistory.entries[navHistory.index + 1];
    if (!entry) return;
    setNavHistory(prev => ({ ...prev, index: prev.index + 1 }));
    setCurrentPathState(entry.path);
    setFolderStack(entry.ids);
    setFolderSharedStack(entry.shared);
  };

  // Download

  const downloadFiles = async (ids: string[]) => {
    // Guard with a ref, not isDownloading state: state updates aren't synchronous,
    // so two rapid clicks could both read `false` and fire duplicate downloads.
    if (downloadInProgressRef.current || ids.length === 0) return;
    downloadInProgressRef.current = true;

    setIsDownloading(true);
    try {
      if (isElectron()) {
        if (ids.length > 1) {
          const result = await saveFilesBulkViaElectron(ids);
          if (result.ok) showToast('Files saved', 'success');
          else if (!result.canceled && result.error) showToast(result.error, 'error');
        } else {
          const firstId = ids[0];
          if (!firstId) return;
          const file = files.find(f => f.id === firstId);
          const fileName = file?.name || (file?.type === 'folder' ? 'folder' : 'file');
          const suggestedFileName = file?.type === 'folder' ? `${fileName}.zip` : fileName;
          const result = await saveFileViaElectron({ fileId: firstId, suggestedFileName });
          if (result.ok) showToast('File saved', 'success');
          else if (!result.canceled && result.error) showToast(result.error, 'error');
        }
        return;
      }

      // Web: bulk download creates a single ZIP
      if (ids.length > 1) {
        const res = await fetch('/api/files/download/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
          body: JSON.stringify({ ids }),
        });

        if (!res.ok) {
          const errorMessage = await extractResponseError(res);
          showToast(errorMessage || 'Failed to download files', 'error');
          throw new Error(errorMessage || 'Failed to download files');
        }

        const filename = parseContentDispositionFilename(
          res.headers.get('Content-Disposition'),
          `download_${Date.now()}.zip`
        );
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Defer revocation so the browser has time to start the download
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      } else {
        const firstId = ids[0];
        if (!firstId) return;
        const file = files.find(f => f.id === firstId);
        if (file) {
          const fileName = file.name || (file.type === 'folder' ? 'folder' : 'file');
          await downloadFileApi(firstId, file.type === 'folder' ? `${fileName}.zip` : fileName);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast(errorMessage || 'Failed to download files', 'error');
    } finally {
      downloadInProgressRef.current = false;
      setIsDownloading(false);
    }
  };

  // Config & Updates

  const refreshOnlyOfficeConfig = useCallback(async () => {
    if (!hasAuthState()) {
      setOnlyOfficeConfigured(false);
      return;
    }
    try {
      const result = await checkOnlyOfficeConfigured();
      setOnlyOfficeConfigured(result.configured);
    } catch {
      setOnlyOfficeConfigured(false);
    }
  }, []);

  useEffect(() => {
    const loadAdminStatus = async () => {
      try {
        const status = await getSignupStatus();
        setCanConfigureOnlyOffice(status.canToggle);
        setHideFileExtensions(status.hideFileExtensions === true);
      } catch {
        setCanConfigureOnlyOffice(false);
      }
    };
    Promise.resolve().then(() => {
      void loadAdminStatus();
      void refreshOnlyOfficeConfig();
    });
  }, [refreshOnlyOfficeConfig]);

  /**
   * Stops a batched upload: marks the group so no further batch is sent, then
   * aborts whatever is already on the wire. Batches that already landed stay
   * uploaded — cancelling stops the rest, it does not undo the delivered ones.
   */
  const cancelUploadBatchGroup = (key: string): boolean => {
    const group = uploadGroupRef.current.get(key);
    if (!group) return false;
    group.cancelled = true;
    group.xhrs.forEach(xhr => xhr.abort());
    group.xhrs.clear();
    return true;
  };

  const cancelUpload = (uploadId: string) => {
    if (cancelUploadBatchGroup(uploadId)) {
      setUploadProgress(prev => removeUploadProgress(prev, uploadId));
      debouncedRefreshFiles(true);
      return;
    }
    const xhr = uploadXhrRef.current.get(uploadId);
    if (xhr) {
      xhr.abort();
      setUploadProgress(prev => removeUploadProgress(prev, uploadId));
      uploadXhrRef.current.delete(uploadId);
      return;
    }
    setUploadProgress(prev => removeUploadProgress(prev, uploadId));
  };

  const cancelUploadGroup = (groupId: string) => {
    cancelUploadBatchGroup(groupId);
    const idsToCancel = uploadProgress.filter(item => item.groupId === groupId).map(item => item.id);
    if (idsToCancel.length === 0) return;
    idsToCancel.forEach(id => {
      const xhr = uploadXhrRef.current.get(id);
      if (xhr) {
        xhr.abort();
        uploadXhrRef.current.delete(id);
      }
      setUploadProgress(prev => removeUploadProgress(prev, id));
    });
    debouncedRefreshFiles(true);
  };

  useEffect(() => {
    if (!isElectron() || !user?.id) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = async () => {
      try {
        const v = await getElectronAppVersion();
        await sendClientHeartbeat(v || 'unknown', window.electronAPI?.platform);
      } catch {
        // heartbeat is best-effort
      }
    };

    void beat();
    timer = setInterval(beat, 2 * 60 * 1000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [user?.id]);

  useEffect(() => {
    if (hasCheckedUpdates) return;

    /** Return true when `latest` is strictly newer than `current` using semver-like comparison. */
    const isNewerVersion = (current: string, latest: string): boolean => {
      const parse = (v: string) => v.replace(/^v/i, '').split('.').map(Number);
      const cur = parse(current);
      const lat = parse(latest);
      const len = Math.max(cur.length, lat.length);
      for (let i = 0; i < len; i++) {
        const c = cur[i] ?? 0;
        const l = lat[i] ?? 0;
        if (Number.isNaN(c) || Number.isNaN(l)) return current !== latest;
        if (l > c) return true;
        if (l < c) return false;
      }
      return false;
    };

    const checkForUpdatesOnce = async () => {
      try {
        const [current, latest] = await Promise.all([getCurrentVersions(), fetchLatestVersions()]);
        const outdated: { frontend?: string; backend?: string; electron?: string } = {};

        if (current.frontend && latest.frontend && isNewerVersion(current.frontend, latest.frontend)) {
          outdated.frontend = latest.frontend;
        }
        if (current.backend && latest.backend && isNewerVersion(current.backend, latest.backend)) {
          outdated.backend = latest.backend;
        }
        if (isElectron() && latest.electron) {
          try {
            const v = await getElectronAppVersion();
            if (v && isNewerVersion(v, latest.electron)) outdated.electron = latest.electron;
          } catch {
            // Ignore Electron version errors for the banner
          }
        }

        setUpdatesAvailable(Object.keys(outdated).length > 0 ? outdated : null);
      } catch {
        setUpdatesAvailable(null);
      } finally {
        setHasCheckedUpdates(true);
      }
    };
    void checkForUpdatesOnce();
  }, [hasCheckedUpdates]);

  const runElectronAutoUpdate = useCallback(async (version: string) => {
    if (!isElectron() || !version) return;
    if (electronAutoUpdateTriggeredRef.current) return;

    electronAutoUpdateTriggeredRef.current = true;
    setElectronAutoUpdateState({ status: 'downloading', progress: 0 });

    const unsubscribe = subscribeToUpdateDownloadProgress(percent => {
      setElectronAutoUpdateState(prev => ({ ...prev, progress: percent }));
    });

    try {
      const result = await downloadAndInstallElectronUpdate(version);
      if (result.ok) {
        setElectronAutoUpdateState({ status: 'installing', progress: 100 });
      } else {
        setElectronAutoUpdateState({ status: 'error', progress: null, error: result.error });
        electronAutoUpdateTriggeredRef.current = false;
      }
    } catch {
      setElectronAutoUpdateState({ status: 'error', progress: null, error: 'Auto-update failed unexpectedly' });
      electronAutoUpdateTriggeredRef.current = false;
    } finally {
      unsubscribe();
    }
  }, []);

  const retryElectronUpdate = useCallback(async () => {
    if (!updatesAvailable?.electron) return;
    await runElectronAutoUpdate(updatesAvailable.electron);
  }, [updatesAvailable, runElectronAutoUpdate]);

  // Auto-download & auto-install electron update once detected
  useEffect(() => {
    if (!isElectron() || !updatesAvailable?.electron) return;
    if (electronAutoUpdateTriggeredRef.current) return;

    const autoUpdateDelay = setTimeout(async () => {
      const version = updatesAvailable?.electron;
      if (!version) return;
      await runElectronAutoUpdate(version);
    }, 3000);

    return () => clearTimeout(autoUpdateDelay);
  }, [updatesAvailable?.electron, runElectronAutoUpdate]);

  // Provide context

  return (
    <AppContext.Provider
      value={{
        currentPath,
        folderStack,
        folderSharedStack,
        files,
        selectedFiles,
        viewMode,
        sidebarOpen,
        uploadModalOpen,
        uploadModalProcessing,
        setUploadModalProcessing,
        uploadModalProcessingRequestId,
        setUploadModalProcessingRequestId,
        uploadScanCount,
        setUploadScanCount,
        createFolderModalOpen,
        imageViewerFile,
        setImageViewerFile,
        documentViewerFile,
        setDocumentViewerFile,
        shareLinkModalOpen,
        shareLinks,
        setShareLinkModalOpen: (open: boolean, links: string[] = []) => {
          setShareLinks(open ? links : []);
          setShareLinkModalOpenState(open);
        },
        renameTarget,
        setRenameTarget,
        renameFile: renameFileApi,
        setCurrentPath,
        setFiles,
        setSelectedFiles,
        setViewMode,
        setSidebarOpen,
        setUploadModalOpen,
        uploadModalInitialEntries,
        openUploadModalWithEntries: (entries: UploadModalInitialEntry[]) => {
          setUploadModalInitialEntries(entries);
          setUploadModalOpen(true);
        },
        clearUploadModalInitialEntries: () => setUploadModalInitialEntries(null),
        setCreateFolderModalOpen,
        addSelectedFile: (id: string) => setSelectedFiles(prev => [...prev, id]),
        removeSelectedFile: (id: string) => setSelectedFiles(prev => prev.filter(fId => fId !== id)),
        clearSelection: () => setSelectedFiles([]),
        refreshFiles,
        createFolder,
        uploadFile,
        moveFiles,
        copyFiles: copyFilesApi,
        shareFiles: shareFilesApi,
        getShareLinks,
        linkToParentShare: linkToParentShareApi,
        starFiles: starFilesApi,
        deleteFiles: deleteFilesApi,
        restoreFiles: restoreFilesApi,
        deleteForever: deleteForeverApi,
        emptyTrash: emptyTrashApi,
        clipboard,
        setClipboard,
        clipboardCopy,
        clipboardPaste,
        pasteProgress,
        setPasteProgress,
        openFolder,
        navigateTo,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        sortBy,
        sortOrder,
        setSortBy,
        setSortOrder,
        searchQuery,
        setSearchQuery,
        isSearching,
        searchFiles: searchFilesApi,
        isDownloading,
        isDeleting,
        isRestoring,
        deleteProgress,
        restoreProgress,
        downloadFiles,
        editFileWithDesktop,
        uploadProgress,
        setUploadProgress,
        uploadFileWithProgress,
        replaceFileWithProgress,
        cancelUpload,
        cancelUploadGroup,
        uploadFilesBulk,
        uploadEntriesBulk,
        setIsUploadProgressInteracting,
        onlyOfficeConfigured,
        canConfigureOnlyOffice,
        refreshOnlyOfficeConfig,
        hideFileExtensions,
        setHideFileExtensions,
        updatesAvailable,
        electronAutoUpdateState,
        retryElectronUpdate,
        desktopOpenProgress,
        setDesktopOpenProgress,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
