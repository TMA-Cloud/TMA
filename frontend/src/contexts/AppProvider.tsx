import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  AppContext,
  type BulkUploadEntry,
  type FileItem,
  type FileItemResponse,
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
  copyFilesToPcClipboard,
  MAX_COPY_TO_PC_BYTES,
  editFileWithDesktopElectron,
  saveFileViaElectron,
  saveFilesBulkViaElectron,
  getElectronAppVersion,
  downloadAndInstallElectronUpdate,
  subscribeToUpdateDownloadProgress,
} from '../utils/electronDesktop';
import { formatBytes } from '../utils/storageUtils';

// Constants & Pure Helpers

const FILE_MANAGER_PAGES = new Set(['My Files', 'Shared', 'Starred', 'Trash']);

const isFileManagerPage = (page: string | undefined) => !!page && FILE_MANAGER_PAGES.has(page);

const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

const mapFileResponse = (f: FileItemResponse): FileItem => ({
  ...f,
  modified: new Date(f.modified),
  deletedAt: f.deletedAt ? new Date(f.deletedAt) : undefined,
  expiresAt: f.expiresAt ? new Date(f.expiresAt) : f.expiresAt === null ? null : undefined,
});

const getInFlightUploadProgress = (loaded: number, total: number): number =>
  Math.min(Math.round((loaded / total) * 100), 99);

function sortFilesWithFoldersFirst(
  items: FileItem[],
  sortBy: 'name' | 'size' | 'modified' | 'deletedAt',
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
  const [uploadModalInitialEntries, setUploadModalInitialEntries] = useState<UploadModalInitialEntry[] | null>(null);
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false);
  const [imageViewerFile, setImageViewerFile] = useState<FileItem | null>(null);
  const [documentViewerFile, setDocumentViewerFile] = useState<FileItem | null>(null);
  const [shareLinkModalOpen, setShareLinkModalOpenState] = useState(false);
  const [shareLinks, setShareLinks] = useState<string[]>([]);
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [clipboard, setClipboard] = useState<{ ids: string[]; action: 'copy' | 'cut' } | null>(null);
  const [pasteProgress, setPasteProgress] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'modified' | 'deletedAt'>('name');
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
  const searchQueryRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const filesRef = useRef<FileItem[]>(files);
  const filesBeforeSearchRef = useRef<FileItem[] | null>(null);
  const didSavePreSearchRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      try {
        if (!skipSearchCheck && searchQuery.trim().length > 0) return;
        if (!isFileManagerPage(currentPath[0])) {
          returnHighlightAfterRefreshRef.current = null;
          return;
        }

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

        const res = await fetch(url.toString(), { credentials: 'include' });
        const data: FileItemResponse[] = await res.json();
        const sorted = sortFilesWithFoldersFirst(data.map(mapFileResponse), sortBy, sortOrder);
        setFiles(sorted);

        const highlightId = returnHighlightAfterRefreshRef.current;
        returnHighlightAfterRefreshRef.current = null;
        if (highlightId && sorted.some(f => f.id === highlightId)) {
          setSelectedFiles([highlightId]);
        }
      } catch {
        // UI will show empty state
        returnHighlightAfterRefreshRef.current = null;
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
        headers: { 'Content-Type': 'application/json' },
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
      setIsSearching(false);

      if (!isFileManagerPage(currentPathRef.current[0]) && filesBeforeSearchRef.current) {
        setFiles(filesBeforeSearchRef.current);
      } else {
        void refreshFiles(true);
      }
      filesBeforeSearchRef.current = null;
      didSavePreSearchRef.current = false;
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
          showToast(`Saving exported file "${display}"${size}.`, 'info');
        } else if (payload.state === 'completed') {
          showToast(`Exported file "${display}".`, 'success');
          debouncedRefreshFiles(true);
        } else if (payload.state === 'error') {
          showToast(payload.error || `Failed to save exported file "${display}". Please try again.`, 'error');
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

  const debouncedSSERefresh = () => {
    if (sseRefreshTimeoutRef.current) clearTimeout(sseRefreshTimeoutRef.current);
    sseRefreshTimeoutRef.current = setTimeout(() => {
      refreshFilesRef.current?.(true);
      sseRefreshTimeoutRef.current = null;
    }, 800);
  };

  useEffect(() => {
    const eventSource = new EventSource('/api/files/events', { withCredentials: true });

    eventSource.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected' || data.type === 'error') return;
        if (data.type && data.data && isEventRelevant(data.type, data.data)) {
          debouncedSSERefresh();
        }
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('[SSE] Error parsing event:', error, event.data);
        }
      }
    };

    eventSourceRef.current = eventSource;

    return () => {
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
      void refreshFiles(true);
    }
  }, [folderStack, currentPath, sortBy, sortOrder, searchQuery, refreshFiles]);

  // File Operations

  const createFolder = async (name: string) => {
    const res = await fetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch('/api/files/upload', { method: 'POST', credentials: 'include', body: data });
      if (!res.ok) throw new Error(await extractResponseError(res));
      await refreshFiles();
    });
  };

  const uploadFilesBulk = async (filesToUpload: File[]) => {
    return uploadEntriesBulk(filesToUpload.map(file => ({ file })));
  };

  const uploadEntriesBulk = async (entries: BulkUploadEntry[]) => {
    if (entries.length === 0) return;
    const allFiles = entries.map(e => e.file);

    return operationQueue.add(async () => {
      await validateUploadSize(allFiles);

      const parentId = folderStack[folderStack.length - 1];
      const hasRelativePaths = entries.some(e => e.relativePath);

      // Folder uploads must be a single bulk XHR to avoid duplicate folder creation
      if (hasRelativePaths) {
        return new Promise<void>((resolve, reject) => {
          const batchGroupId = entries.length > 1 ? `bulk-${Date.now()}-${Math.random()}` : undefined;
          const uploadId = batchGroupId || `bulk-${Date.now()}-${Math.random()}`;
          const xhr = new XMLHttpRequest();
          const data = new FormData();
          if (parentId) data.append('parentId', parentId);

          const normalizedEntries = entries.map((entry, i) => ({
            ...entry,
            clientId: entry.clientId || `${uploadId}-${i}`,
            relativePath: entry.relativePath || '',
          }));

          normalizedEntries.forEach(entry => {
            data.append('files', entry.file);
            data.append('relativePaths', entry.relativePath);
            data.append('clientIds', entry.clientId);
          });

          const progressItems = normalizedEntries.map(entry => ({
            id: entry.clientId,
            fileName: entry.relativePath || entry.file.name,
            fileSize: entry.file.size,
            progress: 0,
            status: 'uploading' as const,
            groupId: batchGroupId,
          }));

          setUploadProgress(prev => [...prev, ...progressItems]);
          progressItems.forEach(item => uploadXhrRef.current.set(item.id, xhr));

          xhr.upload.addEventListener('progress', e => {
            if (e.lengthComputable) {
              const progress = getInFlightUploadProgress(e.loaded, e.total);
              progressItems.forEach(item => {
                const status: UploadProgressItem['status'] = progress >= 99 ? 'finalizing' : 'uploading';
                setUploadProgress(prev => updateUploadProgress(prev, item.id, { progress, status }));
              });
            }
          });

          const markAllStatus = (status: 'completed' | 'error', progress?: number) => {
            progressItems.forEach(item => {
              setUploadProgress(prev =>
                updateUploadProgress(prev, item.id, { status, ...(progress != null ? { progress } : {}) })
              );
            });
          };

          const cleanupXhrRefs = () => {
            progressItems.forEach(item => uploadXhrRef.current.delete(item.id));
          };

          const scheduleAutoDismissAll = () => {
            progressItems.forEach(item => {
              const timeout = createAutoDismissTimeout(
                item.id,
                isUploadProgressInteractingRef,
                setUploadProgress,
                uploadDismissTimeoutsRef,
                3000,
                2000
              );
              uploadDismissTimeoutsRef.current.set(item.id, timeout);
            });
          };

          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const response = JSON.parse(xhr.responseText);
                const { files: uploaded, failed } = response;

                if (Array.isArray(uploaded)) {
                  uploaded.forEach((f: { clientId?: string }) => {
                    if (f?.clientId) {
                      setUploadProgress(prev =>
                        updateUploadProgress(prev, f.clientId!, { progress: 100, status: 'completed' })
                      );
                    }
                  });
                }

                if (Array.isArray(failed) && failed.length > 0) {
                  failed.forEach((f: { fileName: string; error: string; clientId?: string }) => {
                    if (f.clientId) {
                      setUploadProgress(prev => updateUploadProgress(prev, f.clientId!, { status: 'error' }));
                    }
                    showToast(`Failed to upload ${f.fileName}: ${f.error}`, 'error');
                  });
                }

                // Fallback: if backend didn't return clientIds, mark all as completed
                if (!Array.isArray(uploaded) || uploaded.every((f: { clientId?: string }) => !f?.clientId)) {
                  markAllStatus('completed', 100);
                }

                debouncedRefreshFiles(false);
                scheduleAutoDismissAll();
                resolve();
              } catch {
                markAllStatus('completed', 100);
                debouncedRefreshFiles(false);
                resolve();
              }
            } else {
              markAllStatus('error');
              const errorMessage = extractXhrErrorMessage(xhr);
              showToast(errorMessage || 'Bulk upload failed', 'error');
              reject(new Error(errorMessage || 'Bulk upload failed'));
            }
            cleanupXhrRefs();
          });

          xhr.addEventListener('error', () => {
            markAllStatus('error');
            const errorMessage =
              extractXhrErrorMessage(xhr) || 'Upload failed. Please check your connection and try again.';
            showToast(errorMessage, 'error');
            reject(new Error(errorMessage));
            cleanupXhrRefs();
          });

          xhr.addEventListener('abort', () => {
            progressItems.forEach(item => setUploadProgress(prev => removeUploadProgress(prev, item.id)));
            reject(new Error('Upload cancelled'));
            cleanupXhrRefs();
          });

          xhr.open('POST', '/api/files/upload/bulk');
          xhr.withCredentials = true;
          xhr.send(data);
        });
      }

      // Flat multi-file: one XHR per file for independent cancellation
      await Promise.all(
        entries.map((entry, index) => {
          const clientId = entry.clientId || `file-${Date.now()}-${index}`;
          const formData = new FormData();
          if (parentId) formData.append('parentId', parentId);
          formData.append('files', entry.file);
          formData.append('clientIds', clientId);

          return executeXhrUpload({
            url: '/api/files/upload/bulk',
            formData,
            uploadId: clientId,
            fileName: entry.file.name,
            fileSize: entry.file.size,
          });
        })
      );
    });
  };

  const uploadFilesFromClipboard = async () => {
    const clipFiles = await getFilesFromElectronClipboard();
    if (clipFiles.length === 0) {
      showToast('No files on clipboard.', 'info');
      return;
    }
    await uploadFilesBulk(clipFiles);
  };

  const copyFilesToPc = async (ids: string[]) => {
    if (ids.length === 0) return;
    const fileItems = ids
      .map(id => files.find(f => f.id === id))
      .filter((f): f is FileItem => f != null && String(f.type || '').toLowerCase() !== 'folder');
    if (fileItems.length === 0) {
      showToast('Select at least one file (folders are not supported)', 'error');
      return;
    }
    const anyOverLimit = fileItems.some(f => f.size != null && Number(f.size) > MAX_COPY_TO_PC_BYTES);
    const totalBytes = fileItems.reduce((s, f) => s + Number(f.size ?? 0), 0);
    if (anyOverLimit || totalBytes > MAX_COPY_TO_PC_BYTES) {
      showToast('Copy to computer is only allowed for files up to 200 MB total.', 'error');
      return;
    }
    const items = fileItems.map(f => ({ id: f.id, name: f.name }));
    const result = await copyFilesToPcClipboard(items);
    if (result.ok) {
      showToast(
        `Copied ${items.length} file${items.length !== 1 ? 's' : ''} to clipboard. Paste in Explorer to save.`,
        'success'
      );
    } else {
      showToast(result.error ?? 'Failed to copy to computer', 'error');
    }
  };

  const editFileWithDesktop = async (id: string) => {
    if (desktopEditInProgressRef.current.has(id)) {
      showToast('Already opening this file on desktop. Please wait...', 'info');
      return;
    }

    const file = files.find(f => f.id === id);
    if (!file || String(file.type || '').toLowerCase() === 'folder') {
      showToast('Select a single file to open on desktop.', 'error');
      return;
    }
    if (!file.mimeType) {
      showToast('Cannot open this file on desktop: unknown type.', 'error');
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
        showToast(result.error ?? 'Failed to open or edit file on desktop.', 'error');
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
      showToast('File opened on desktop. Changes will be auto-synced.', 'success');
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id, name }),
    });

    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      showToast(errorMessage || 'Failed to rename item!!', 'error');
      throw new Error(errorMessage || 'Failed to rename item');
    }

    try {
      const updated: FileItemResponse = await res.json();
      showToast(`Renamed to "${updated.name || name}"`, 'success');
    } catch {
      showToast('Item renamed successfully', 'success');
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Failed to empty trash');
    await refreshFiles();
    return data;
  };

  const linkToParentShareApi = async (ids: string[]): Promise<Record<string, string>> => {
    const res = await fetch('/api/files/link-parent-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'application/json' },
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
    if (isDownloading || ids.length === 0) return;

    setIsDownloading(true);
    try {
      if (isElectron()) {
        if (ids.length > 1) {
          const result = await saveFilesBulkViaElectron(ids);
          if (result.ok) showToast('Files saved successfully', 'success');
          else if (!result.canceled && result.error) showToast(result.error, 'error');
        } else {
          const firstId = ids[0];
          if (!firstId) return;
          const file = files.find(f => f.id === firstId);
          const fileName = file?.name || (file?.type === 'folder' ? 'folder' : 'file');
          const suggestedFileName = file?.type === 'folder' ? `${fileName}.zip` : fileName;
          const result = await saveFileViaElectron({ fileId: firstId, suggestedFileName });
          if (result.ok) showToast('File saved successfully', 'success');
          else if (!result.canceled && result.error) showToast(result.error, 'error');
        }
        return;
      }

      // Web: bulk download creates a single ZIP
      if (ids.length > 1) {
        const res = await fetch('/api/files/download/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        window.URL.revokeObjectURL(url);
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
    void loadAdminStatus();
    void refreshOnlyOfficeConfig();
  }, [refreshOnlyOfficeConfig]);

  const cancelUpload = (uploadId: string) => {
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
    const idsToCancel = uploadProgress.filter(item => item.groupId === groupId).map(item => item.id);
    if (idsToCancel.length === 0) return;
    idsToCancel.forEach(id => {
      const xhr = uploadXhrRef.current.get(id);
      if (xhr) {
        xhr.abort();
        setUploadProgress(prev => removeUploadProgress(prev, id));
        uploadXhrRef.current.delete(id);
      } else {
        setUploadProgress(prev => removeUploadProgress(prev, id));
      }
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
    const checkForUpdatesOnce = async () => {
      try {
        const [current, latest] = await Promise.all([getCurrentVersions(), fetchLatestVersions()]);
        const outdated: { frontend?: string; backend?: string; electron?: string } = {};

        if (current.frontend && latest.frontend && current.frontend !== latest.frontend) {
          outdated.frontend = latest.frontend;
        }
        if (current.backend && latest.backend && current.backend !== latest.backend) {
          outdated.backend = latest.backend;
        }
        if (isElectron() && latest.electron) {
          try {
            const v = await getElectronAppVersion();
            if (v && v !== latest.electron) outdated.electron = latest.electron;
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
  }, [updatesAvailable?.electron, runElectronAutoUpdate]);

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
        pasteClipboard,
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
        copyFilesToPc,
        editFileWithDesktop,
        uploadProgress,
        setUploadProgress,
        uploadFileWithProgress,
        replaceFileWithProgress,
        cancelUpload,
        cancelUploadGroup,
        uploadFilesBulk,
        uploadEntriesBulk,
        uploadFilesFromClipboard,
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
