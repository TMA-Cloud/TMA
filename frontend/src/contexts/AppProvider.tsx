import React, { useCallback, useEffect, useState, useRef } from 'react';
import { AppContext, type FileItem, type FileItemResponse, type ShareExpiry } from './AppContext';
import { usePromiseQueue, useDebouncedCallback } from '../utils/debounce';
import {
  downloadFile as downloadFileApi,
  checkOnlyOfficeConfigured,
  getSignupStatus,
  hasAuthState,
  checkUploadStorage,
  getMaxUploadSizeConfig,
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
} from '../utils/electronDesktop';
import { formatBytes } from '../utils/storageUtils';

function sortFilesWithFoldersFirst(
  items: FileItem[],
  sortBy: 'name' | 'size' | 'modified' | 'deletedAt',
  sortOrder: 'asc' | 'desc'
): FileItem[] {
  const direction = sortOrder === 'desc' ? -1 : 1;

  const compareCore = (a: FileItem, b: FileItem): number => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name, undefined, {
          sensitivity: 'base',
          numeric: true,
        });
      case 'size': {
        const aSize = a.size ?? 0;
        const bSize = b.size ?? 0;
        if (aSize === bSize) {
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
            numeric: true,
          });
        }
        return aSize < bSize ? -1 : 1;
      }
      case 'deletedAt': {
        const aDate = a.deletedAt ? a.deletedAt.getTime() : 0;
        const bDate = b.deletedAt ? b.deletedAt.getTime() : 0;
        if (aDate === bDate) {
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
            numeric: true,
          });
        }
        return aDate < bDate ? -1 : 1;
      }
      case 'modified':
      default: {
        const aDate = a.modified ? a.modified.getTime() : 0;
        const bDate = b.modified ? b.modified.getTime() : 0;
        if (aDate === bDate) {
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
            numeric: true,
          });
        }
        return aDate < bDate ? -1 : 1;
      }
    }
  };

  return [...items].sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return compareCore(a, b) * direction;
  });
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { showToast } = useToast();
  const [currentPath, setCurrentPathState] = useState<string[]>(['My Files']);
  const [folderStack, setFolderStack] = useState<(string | null)[]>([null]);
  const [folderSharedStack, setFolderSharedStack] = useState<boolean[]>([false]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false);
  const [imageViewerFile, setImageViewerFile] = useState<FileItem | null>(null);
  const [documentViewerFile, setDocumentViewerFile] = useState<FileItem | null>(null);
  const [shareLinkModalOpen, setShareLinkModalOpenState] = useState(false);
  const [shareLinks, setShareLinks] = useState<string[]>([]);
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [clipboard, setClipboard] = useState<{
    ids: string[];
    action: 'copy' | 'cut';
  } | null>(null);
  const [pasteProgress, setPasteProgress] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'modified' | 'deletedAt'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressItem[]>([]);
  const [isUploadProgressInteracting, setIsUploadProgressInteracting] = useState(false);
  const [onlyOfficeConfigured, setOnlyOfficeConfigured] = useState(false);
  const [canConfigureOnlyOffice, setCanConfigureOnlyOffice] = useState(false);
  const isUploadProgressInteractingRef = useRef(false);
  const uploadDismissTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const searchQueryRef = useRef<string>(''); // Track current search query to ignore stale results
  const abortControllerRef = useRef<AbortController | null>(null); // For cancelling fetch requests
  const eventSourceRef = useRef<EventSource | null>(null); // For SSE connection
  const sseRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // For debouncing SSE refresh
  const currentPathRef = useRef<string[]>(currentPath); // Track current path for SSE relevance check
  const folderStackRef = useRef<(string | null)[]>(folderStack); // Track folder stack for SSE relevance check
  const refreshFilesRef = useRef<((skipSearchCheck?: boolean) => Promise<void>) | null>(null); // Track refreshFiles function for SSE

  const operationQueue = usePromiseQueue();

  // Keep ref in sync with state
  useEffect(() => {
    isUploadProgressInteractingRef.current = isUploadProgressInteracting;
  }, [isUploadProgressInteracting]);

  // When user stops interacting, dismiss completed items after a short delay
  useEffect(() => {
    if (!isUploadProgressInteracting) {
      // User stopped interacting, wait 2 seconds then dismiss completed items
      const checkTimeout = setTimeout(() => {
        // Double-check that user is still not interacting
        if (!isUploadProgressInteractingRef.current) {
          // Dismiss all completed and error items (errors after longer delay)
          setUploadProgress(prev => {
            const itemsToKeep = prev.filter(item => {
              if (item.status === 'completed') {
                // Clean up any pending timeouts for dismissed items
                const timeout = uploadDismissTimeoutsRef.current.get(item.id);
                if (timeout) {
                  clearTimeout(timeout);
                  uploadDismissTimeoutsRef.current.delete(item.id);
                }
                return false; // Dismiss completed items
              }
              if (item.status === 'error') {
                // Dismiss error items too (they've been visible long enough)
                const timeout = uploadDismissTimeoutsRef.current.get(item.id);
                if (timeout) {
                  clearTimeout(timeout);
                  uploadDismissTimeoutsRef.current.delete(item.id);
                }
                return false; // Dismiss error items
              }
              return true; // Keep uploading items
            });
            return itemsToKeep;
          });
        }
      }, 2000); // Wait 2 seconds after user stops interacting
      return () => clearTimeout(checkTimeout);
    } else {
      // User started interacting, cancel any pending dismissals
      uploadDismissTimeoutsRef.current.forEach(timeout => {
        clearTimeout(timeout);
      });
      uploadDismissTimeoutsRef.current.clear();
    }
  }, [isUploadProgressInteracting]);

  // Keep refs in sync with state
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    folderStackRef.current = folderStack;
  }, [folderStack]);

  // Helper to extract share URLs from backend response.
  // Backend already provides full URLs in `links` - just return them as-is.
  const buildShareUrlMap = useCallback((data: { links?: Record<string, string> }) => {
    return data?.links || {};
  }, []);

  const refreshFiles = useCallback(
    async (skipSearchCheck = false) => {
      try {
        // If searching, don't refresh normally - search handles its own file updates
        // skipSearchCheck is used when we explicitly want to refresh (e.g., when clearing search)
        if (!skipSearchCheck && searchQuery.trim().length > 0) {
          return;
        }

        // Only fetch files if we're on a file manager page
        const currentPage = currentPath[0];
        const isFileManagerPage =
          currentPage === 'My Files' ||
          currentPage === 'Shared' ||
          currentPage === 'Starred' ||
          currentPage === 'Trash';

        if (!isFileManagerPage) {
          return;
        }

        const parentId = folderStack[folderStack.length - 1];
        let urlPath = `/api/files`;
        if (currentPath[0] === 'Starred' && folderStack.length === 1) {
          urlPath = `/api/files/starred`;
        } else if (currentPath[0] === 'Shared' && folderStack.length === 1) {
          urlPath = `/api/files/shared`;
        } else if (currentPath[0] === 'Trash' && folderStack.length === 1) {
          urlPath = `/api/files/trash`;
        }

        const url = new URL(urlPath, window.location.origin);
        if (parentId) url.searchParams.append('parentId', parentId);
        url.searchParams.append('sortBy', sortBy);
        // Only append order if it has a valid value
        // Backend will validate and convert to uppercase
        if (sortOrder && sortOrder.trim()) {
          url.searchParams.append('order', sortOrder);
        }
        const res = await fetch(url.toString(), {
          credentials: 'include',
        });
        const data: FileItemResponse[] = await res.json();
        const mapped: FileItem[] = data.map(f => ({
          ...f,
          modified: new Date(f.modified),
          deletedAt: f.deletedAt ? new Date(f.deletedAt) : undefined,
          expiresAt: f.expiresAt ? new Date(f.expiresAt) : f.expiresAt === null ? null : undefined,
        }));
        setFiles(sortFilesWithFoldersFirst(mapped, sortBy, sortOrder));
      } catch {
        // Silently handle file loading errors - UI will show empty state
      }
    },
    [folderStack, currentPath, sortBy, sortOrder, searchQuery]
  );

  // Debounced refresh for uploads - batches multiple upload completions into a single refresh
  const [debouncedRefreshFiles] = useDebouncedCallback(
    (...args: unknown[]) => {
      const skipSearchCheck = (args[0] as boolean | undefined) ?? false;
      void refreshFiles(skipSearchCheck);
    },
    500 // 500ms delay - batches upload completions that happen close together
  );

  // Keep refreshFiles ref in sync (after refreshFiles is declared)
  useEffect(() => {
    refreshFilesRef.current = refreshFiles;
  }, [refreshFiles]);

  const searchFilesApi = useCallback(
    async (query: string) => {
      const trimmedQuery = query.trim();

      // Check if this search result is still relevant (query hasn't changed)
      if (searchQueryRef.current.trim() !== trimmedQuery) {
        // Query has changed, ignore this result
        return;
      }

      if (!trimmedQuery || trimmedQuery.length === 0) {
        // If search is cleared, refresh normal files
        setIsSearching(false);
        await refreshFiles(true); // Force refresh by skipping search check
        return;
      }

      // Cancel any previous search request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Create new AbortController for this search
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setIsSearching(true);
      try {
        const url = new URL(`/api/files/search`, window.location.origin);
        url.searchParams.append('q', trimmedQuery);
        url.searchParams.append('limit', '100');

        const res = await fetch(url.toString(), {
          credentials: 'include',
          signal: abortController.signal, // Enable request cancellation
        });

        // Check if request was aborted
        if (abortController.signal.aborted) {
          return;
        }

        if (!res.ok) {
          throw new Error('Search failed');
        }

        // Double-check query hasn't changed while fetching
        if (searchQueryRef.current.trim() !== trimmedQuery) {
          // Query changed during fetch, ignore this result
          return;
        }

        const data: FileItemResponse[] = await res.json();

        // Final check before updating state
        if (searchQueryRef.current.trim() !== trimmedQuery) {
          return;
        }

        const mapped: FileItem[] = data.map(f => ({
          ...f,
          modified: new Date(f.modified),
          deletedAt: f.deletedAt ? new Date(f.deletedAt) : undefined,
          expiresAt: f.expiresAt == null ? f.expiresAt : new Date(f.expiresAt),
        }));

        setFiles(sortFilesWithFoldersFirst(mapped, sortBy, sortOrder));
      } catch (e) {
        // Ignore abort errors (expected when cancelling)
        if (e instanceof Error && e.name === 'AbortError') {
          return;
        }

        // Only update state if query is still relevant and not aborted
        if (searchQueryRef.current.trim() === trimmedQuery && !abortController.signal.aborted) {
          // Silently handle search errors - UI will show empty results
          setFiles([]);
        }
      } finally {
        // Only update searching state if query is still relevant and controller wasn't replaced
        if (searchQueryRef.current.trim() === trimmedQuery && abortControllerRef.current === abortController) {
          setIsSearching(false);
          abortControllerRef.current = null;
        }
      }
    },
    [refreshFiles, sortBy, sortOrder]
  );

  // Debounced search function with cancellation support
  const [debouncedSearch, cancelSearch] = useDebouncedCallback(
    ((query: string) => searchFilesApi(query)) as (...args: unknown[]) => unknown,
    300
  );

  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      // Trigger debounced search
      debouncedSearch(searchQuery);
    } else {
      // Cancel any pending searches immediately
      cancelSearch();

      // Abort any in-flight fetch requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      // Clear search and refresh normal files immediately
      setIsSearching(false);
      // Use skipSearchCheck to force refresh even if searchQuery is being cleared
      void refreshFiles(true);
    }
  }, [searchQuery, debouncedSearch, cancelSearch, refreshFiles]);

  // Helper function to check if event is relevant (uses refs, no dependencies)
  const isEventRelevant = (
    eventType: string,
    eventData: {
      parentId?: string | null;
      id?: string;
      starred?: boolean;
      shared?: boolean;
    }
  ) => {
    const currentPage = currentPathRef.current[0];
    const currentParentId = folderStackRef.current[folderStackRef.current.length - 1];

    // If in Starred view, only refresh for star/unstar events
    if (currentPage === 'Starred') {
      return eventData.starred !== undefined;
    }

    // If in Shared view, only refresh for share/unshare events
    if (currentPage === 'Shared') {
      return eventData.shared !== undefined;
    }

    // If in Trash view, only refresh for trash-related events
    if (currentPage === 'Trash') {
      return eventType === 'file.deleted' || eventType === 'file.restored' || eventType === 'file.permanently_deleted';
    }

    // For "My Files" view
    if (currentPage === 'My Files') {
      // If we're at root (no parentId), only refresh if event is also at root
      if (!currentParentId) {
        return !eventData.parentId;
      }
      // Otherwise, refresh if parentId matches
      return eventData.parentId === currentParentId;
    }

    // Default: refresh for all events (fallback)
    return true;
  };

  // Debounced refresh function for SSE events (uses refs, no dependencies)
  const debouncedSSERefresh = () => {
    // Clear any pending refresh
    if (sseRefreshTimeoutRef.current) {
      clearTimeout(sseRefreshTimeoutRef.current);
    }
    // Schedule a refresh after 800ms (debounce window)
    sseRefreshTimeoutRef.current = setTimeout(() => {
      if (refreshFilesRef.current) {
        void refreshFilesRef.current(true);
      }
      sseRefreshTimeoutRef.current = null;
    }, 800);
  };

  // Connect to Server-Sent Events for real-time file updates
  // This effect runs once on mount and uses refs to access current values
  useEffect(() => {
    // Create EventSource connection
    const eventSource = new EventSource('/api/files/events', {
      withCredentials: true,
    });

    eventSource.onopen = () => {
      // Connection established
    };

    eventSource.onmessage = event => {
      try {
        const data = JSON.parse(event.data);

        // Handle connection confirmation
        if (data.type === 'connected') {
          return;
        }

        // Handle errors
        if (data.type === 'error') {
          // Silently handle file events stream errors
          return;
        }

        // Handle file events
        if (data.type && data.data) {
          const eventData = data.data;
          const eventType = data.type;

          // Filter by relevance - only refresh if event affects current view
          // Uses refs to get current values without causing re-renders
          // isEventRelevant determines if the event affects the current view
          const isRelevant = isEventRelevant(eventType, eventData);

          if (!isRelevant) {
            return;
          }

          // Debounce/throttle refresh - batch multiple events
          debouncedSSERefresh();
        }
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('[SSE] Error parsing event:', error, event.data);
        }
      }
    };

    eventSource.onerror = () => {
      // Silently handle file events stream errors
      // EventSource will automatically reconnect
    };

    eventSourceRef.current = eventSource;

    // Cleanup on unmount
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
  }, []); // Empty dependency array - connection created once, uses refs for current values

  useEffect(() => {
    // Only refresh files when not searching and searchQuery is empty
    // Also check if we're on a file manager page to avoid unnecessary calls
    const currentPage = currentPath[0];
    const isFileManagerPage =
      currentPage === 'My Files' || currentPage === 'Shared' || currentPage === 'Starred' || currentPage === 'Trash';

    if (searchQuery.trim().length === 0 && isFileManagerPage) {
      void refreshFiles(true); // Force refresh when navigating/filtering
    }
  }, [folderStack, currentPath, sortBy, sortOrder, searchQuery, refreshFiles]);

  const createFolder = async (name: string) => {
    const res = await fetch(`/api/files/folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        name,
        parentId: folderStack[folderStack.length - 1],
      }),
    });
    if (!res.ok) throw new Error(await extractResponseError(res));
    await refreshFiles();
  };

  const uploadFile = async (file: File) => {
    return operationQueue.add(async () => {
      try {
        const { maxBytes } = await getMaxUploadSizeConfig();
        if (file.size > maxBytes) {
          const msg = `This file is too large. Maximum upload size is ${formatBytes(maxBytes)}.`;
          showToast(msg, 'error');
          throw new Error(msg);
        }
        await checkUploadStorage(file.size);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Storage limit exceeded.';
        if (!(e instanceof Error && e.message.startsWith('This file is too large'))) {
          showToast(msg, 'error');
        }
        throw e;
      }
      const data = new FormData();
      const parentId = folderStack[folderStack.length - 1];
      if (parentId) data.append('parentId', parentId);
      data.append('file', file);
      const res = await fetch(`/api/files/upload`, {
        method: 'POST',
        credentials: 'include',
        body: data,
      });
      if (!res.ok) throw new Error(await extractResponseError(res));
      await refreshFiles();
    });
  };

  const uploadFilesBulk = async (files: File[]) => {
    if (files.length === 0) return;

    return operationQueue.add(async () => {
      try {
        const { maxBytes } = await getMaxUploadSizeConfig();
        const oversized = files.find(f => f.size > maxBytes);
        if (oversized) {
          const msg = `"${oversized.name}" is too large. Maximum upload size is ${formatBytes(maxBytes)}.`;
          showToast(msg, 'error');
          throw new Error(msg);
        }
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        await checkUploadStorage(totalSize);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Storage limit exceeded.';
        if (!(e instanceof Error && e.message.startsWith('"'))) {
          showToast(msg, 'error');
        }
        throw e;
      }

      return new Promise<void>((resolve, reject) => {
        const uploadId = `bulk-${Date.now()}-${Math.random()}`;
        const xhr = new XMLHttpRequest();
        const data = new FormData();
        const parentId = folderStack[folderStack.length - 1];
        if (parentId) data.append('parentId', parentId);

        // Append all files with the same field name 'files'
        files.forEach(file => {
          data.append('files', file);
        });

        // Add all files to progress list
        const fileProgressItems = files.map(file => ({
          id: `${uploadId}-${file.name}`,
          fileName: file.name,
          fileSize: file.size,
          progress: 0,
          status: 'uploading' as const,
        }));

        setUploadProgress(prev => [...prev, ...fileProgressItems]);

        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) {
            const progress = Math.round((e.loaded / e.total) * 100);
            // Update progress for all files proportionally
            fileProgressItems.forEach(item => {
              setUploadProgress(prev => updateUploadProgress(prev, item.id, { progress }));
            });
          }
        });

        xhr.addEventListener('load', async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText);
              const { files: uploadedFiles, failed } = response;

              // Mark successful uploads as completed
              uploadedFiles.forEach((file: { name: string }) => {
                const item = fileProgressItems.find(i => i.fileName === file.name);
                if (item) {
                  setUploadProgress(prev =>
                    updateUploadProgress(prev, item.id, {
                      progress: 100,
                      status: 'completed',
                    })
                  );
                }
              });

              // Mark failed uploads as error
              if (failed && failed.length > 0) {
                failed.forEach((failedFile: { fileName: string; error: string }) => {
                  const item = fileProgressItems.find(i => i.fileName === failedFile.fileName);
                  if (item) {
                    setUploadProgress(prev =>
                      updateUploadProgress(prev, item.id, {
                        status: 'error',
                      })
                    );
                    showToast(`Failed to upload ${failedFile.fileName}: ${failedFile.error}`, 'error');
                  }
                });
              }

              // Use debounced refresh to batch multiple upload completions
              debouncedRefreshFiles(false);

              // Auto-dismiss successful uploads after 3 seconds
              fileProgressItems.forEach(item => {
                const dismissTimeout = createAutoDismissTimeout(
                  item.id,
                  isUploadProgressInteractingRef,
                  setUploadProgress,
                  uploadDismissTimeoutsRef,
                  3000,
                  2000
                );
                uploadDismissTimeoutsRef.current.set(item.id, dismissTimeout);
              });

              if (failed && failed.length > 0) {
                // Some files failed, but don't reject the promise
                resolve();
              } else {
                resolve();
              }
            } catch {
              // If response parsing fails, mark all as completed (backend might have succeeded)
              fileProgressItems.forEach(item => {
                setUploadProgress(prev =>
                  updateUploadProgress(prev, item.id, {
                    progress: 100,
                    status: 'completed',
                  })
                );
              });
              debouncedRefreshFiles(false);
              resolve();
            }
          } else {
            // Mark all as error
            fileProgressItems.forEach(item => {
              setUploadProgress(prev => updateUploadProgress(prev, item.id, { status: 'error' }));
            });

            const errorMessage = extractXhrErrorMessage(xhr);
            showToast(errorMessage || 'Bulk upload failed', 'error');
            reject(new Error(errorMessage || 'Bulk upload failed'));
          }
        });

        xhr.addEventListener('error', () => {
          fileProgressItems.forEach(item => {
            setUploadProgress(prev => updateUploadProgress(prev, item.id, { status: 'error' }));
          });

          const errorMessage =
            extractXhrErrorMessage(xhr) || 'Upload failed. Please check your connection and try again.';
          showToast(errorMessage, 'error');
          reject(new Error(errorMessage));
        });

        xhr.addEventListener('abort', () => {
          fileProgressItems.forEach(item => {
            setUploadProgress(prev => removeUploadProgress(prev, item.id));
          });
          reject(new Error('Upload cancelled'));
        });

        xhr.open('POST', `/api/files/upload/bulk`);
        xhr.withCredentials = true;
        xhr.send(data);
      });
    });
  };

  const uploadFilesFromClipboard = async () => {
    const files = await getFilesFromElectronClipboard();
    if (files.length === 0) return;
    await uploadFilesBulk(files);
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
      showToast(`Copy to computer is only allowed for files up to 200 MB total.`, 'error');
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
    const file = files.find(f => f.id === id);
    if (!file || String(file.type || '').toLowerCase() === 'folder') {
      showToast('Select a single file to open on desktop.', 'error');
      return;
    }

    if (!file.mimeType) {
      showToast('Cannot open this file on desktop: unknown type.', 'error');
      return;
    }

    const result = await editFileWithDesktopElectron({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
    });

    if (!result.ok) {
      showToast(result.error ?? 'Failed to open or edit file on desktop.', 'error');
      return;
    }

    showToast('File opened on desktop. Changes will be auto-synced.', 'success');
  };

  const uploadFileWithProgress = async (file: File, onProgress?: (progress: number) => void) => {
    return operationQueue.add(async () => {
      try {
        const { maxBytes } = await getMaxUploadSizeConfig();
        if (file.size > maxBytes) {
          const msg = `This file is too large. Maximum upload size is ${formatBytes(maxBytes)}.`;
          showToast(msg, 'error');
          throw new Error(msg);
        }
        await checkUploadStorage(file.size);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Storage limit exceeded.';
        if (!(e instanceof Error && e.message.startsWith('This file is too large'))) {
          showToast(msg, 'error');
        }
        throw e;
      }

      return new Promise<void>((resolve, reject) => {
        const uploadId = `${Date.now()}-${Math.random()}`;
        const xhr = new XMLHttpRequest();
        const data = new FormData();
        const parentId = folderStack[folderStack.length - 1];
        if (parentId) data.append('parentId', parentId);
        data.append('file', file);

        // Add upload to progress list
        setUploadProgress(prev => [
          ...prev,
          {
            id: uploadId,
            fileName: file.name,
            fileSize: file.size,
            progress: 0,
            status: 'uploading',
          },
        ]);

        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) {
            const progress = Math.round((e.loaded / e.total) * 100);
            setUploadProgress(prev => updateUploadProgress(prev, uploadId, { progress }));
            if (onProgress) {
              onProgress(progress);
            }
          }
        });

        xhr.addEventListener('load', async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(prev =>
              updateUploadProgress(prev, uploadId, {
                progress: 100,
                status: 'completed',
              })
            );
            // Use debounced refresh to batch multiple upload completions
            debouncedRefreshFiles(false);
            // Auto-dismiss after 3 seconds
            const dismissTimeout = createAutoDismissTimeout(
              uploadId,
              isUploadProgressInteractingRef,
              setUploadProgress,
              uploadDismissTimeoutsRef,
              3000,
              2000
            );
            uploadDismissTimeoutsRef.current.set(uploadId, dismissTimeout);
            resolve();
          } else {
            // Abort the upload immediately on error
            xhr.abort();
            setUploadProgress(prev => updateUploadProgress(prev, uploadId, { status: 'error' }));

            // Extract and show error message
            const errorMessage = extractXhrErrorMessage(xhr);
            showToast(errorMessage, 'error');

            // Auto-dismiss failed uploads after 10 seconds
            const errorDismissTimeout = createAutoDismissTimeout(
              uploadId,
              isUploadProgressInteractingRef,
              setUploadProgress,
              uploadDismissTimeoutsRef
            );
            uploadDismissTimeoutsRef.current.set(uploadId, errorDismissTimeout);
            reject(new Error(errorMessage));
          }
        });

        xhr.addEventListener('error', () => {
          xhr.abort();
          setUploadProgress(prev => updateUploadProgress(prev, uploadId, { status: 'error' }));

          const errorMessage =
            extractXhrErrorMessage(xhr) || 'Upload failed. Please check your connection and try again.';
          showToast(errorMessage, 'error');

          const errorDismissTimeout = createAutoDismissTimeout(
            uploadId,
            isUploadProgressInteractingRef,
            setUploadProgress,
            uploadDismissTimeoutsRef
          );
          uploadDismissTimeoutsRef.current.set(uploadId, errorDismissTimeout);
          reject(new Error(errorMessage));
        });

        xhr.addEventListener('abort', () => {
          setUploadProgress(prev => removeUploadProgress(prev, uploadId));
          reject(new Error('Upload cancelled'));
        });

        xhr.open('POST', `/api/files/upload`);
        xhr.withCredentials = true;
        xhr.send(data);
      });
    });
  };

  const moveFiles = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      const res = await fetch(`/api/files/move`, {
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
      const res = await fetch(`/api/files/copy`, {
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
    const res = await fetch(`/api/files/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id, name }),
    });
    if (!res.ok) throw new Error(await extractResponseError(res));
    await refreshFiles();
  };

  const setShareLinkModalOpen = (open: boolean, links: string[] = []) => {
    if (open) {
      setShareLinks(links);
    } else {
      setShareLinks([]);
    }
    setShareLinkModalOpenState(open);
  };

  const shareFilesApi = async (
    ids: string[],
    shared: boolean,
    expiry?: ShareExpiry
  ): Promise<Record<string, string>> => {
    const res = await fetch(`/api/files/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        ids,
        shared,
        ...(shared && expiry ? { expiry } : {}),
      }),
    });
    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      throw new Error(errorMessage || 'Failed to share files');
    }
    const data = await res.json();
    const links = buildShareUrlMap(data);
    await refreshFiles();
    return links;
  };

  const getShareLinks = async (ids: string[]): Promise<Record<string, string>> => {
    const res = await fetch(`/api/files/share/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      throw new Error('Failed to get share links');
    }
    const data = await res.json();
    return buildShareUrlMap(data);
  };

  const starFilesApi = async (ids: string[], starred: boolean) => {
    const res = await fetch(`/api/files/star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ids, starred }),
    });
    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      throw new Error(errorMessage || 'Failed to update star status');
    }
    await refreshFiles();
  };

  const deleteFilesApi = async (ids: string[]) => {
    const res = await fetch(`/api/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(await extractResponseError(res));
    await refreshFiles();
  };

  const restoreFilesApi = async (ids: string[]) => {
    const res = await fetch(`/api/files/trash/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errorMessage = data.message || 'Failed to restore files';
      throw new Error(errorMessage);
    }
    await refreshFiles();
    return data;
  };

  const deleteForeverApi = async (ids: string[]) => {
    const res = await fetch(`/api/files/trash/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(await extractResponseError(res));
    await refreshFiles();
  };

  const emptyTrashApi = async () => {
    const res = await fetch(`/api/files/trash/empty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) {
      const errorMessage = data.message || 'Failed to empty trash';
      throw new Error(errorMessage);
    }
    await refreshFiles();
    return data;
  };

  const linkToParentShareApi = async (ids: string[]): Promise<Record<string, string>> => {
    const res = await fetch(`/api/files/link-parent-share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      throw new Error('Failed to link to parent share');
    }
    const data = await res.json();
    await refreshFiles();
    return buildShareUrlMap(data);
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

  const addSelectedFile = (id: string) => {
    setSelectedFiles(prev => [...prev, id]);
  };

  const removeSelectedFile = (id: string) => {
    setSelectedFiles(prev => prev.filter(fileId => fileId !== id));
  };

  const clearSelection = () => {
    setSelectedFiles([]);
  };

  const setCurrentPath = (path: string[], ids?: (string | null)[]) => {
    setCurrentPathState(path);
    if (ids) {
      setFolderStack(ids);
      setFolderSharedStack(Array(path.length).fill(false));
    } else {
      setFolderStack(Array(path.length).fill(null));
      setFolderSharedStack(Array(path.length).fill(false));
    }
  };

  const openFolder = (folder: FileItem) => {
    // Clear search when navigating to a folder
    if (searchQuery.trim().length > 0) {
      setSearchQuery('');
    }
    setCurrentPathState(p => [...p, folder.name]);
    setFolderStack(p => [...p, folder.id]);
    setFolderSharedStack(p => [...p, !!folder.shared]);
  };

  const navigateTo = (index: number) => {
    setCurrentPathState(p => p.slice(0, index + 1));
    setFolderStack(p => p.slice(0, index + 1));
    setFolderSharedStack(p => p.slice(0, index + 1));
  };

  const downloadFiles = async (ids: string[]) => {
    if (isDownloading || ids.length === 0) return;

    setIsDownloading(true);
    try {
      // Electron: use native Save dialog (title = app name) and show toast on success
      if (isElectron()) {
        if (ids.length > 1) {
          const result = await saveFilesBulkViaElectron(ids);
          if (result.ok) {
            showToast('Files saved successfully', 'success');
          } else if (!result.canceled && result.error) {
            showToast(result.error, 'error');
          }
        } else {
          const firstId = ids[0];
          if (!firstId) return;
          const file = files.find(f => f.id === firstId);
          const fileName = file?.name || (file?.type === 'folder' ? 'folder' : 'file');
          const suggestedFileName = file?.type === 'folder' ? `${fileName}.zip` : fileName;
          const result = await saveFileViaElectron({
            fileId: firstId,
            suggestedFileName,
          });
          if (result.ok) {
            showToast('File saved successfully', 'success');
          } else if (!result.canceled && result.error) {
            showToast(result.error, 'error');
          }
        }
        return;
      }

      // Web: Use bulk download endpoint for multiple files (creates a single ZIP)
      if (ids.length > 1) {
        const res = await fetch(`/api/files/download/bulk`, {
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

        // Get the filename from Content-Disposition header
        const contentDisposition = res.headers.get('Content-Disposition');
        let filename = `download_${Date.now()}.zip`;

        if (contentDisposition) {
          const rfc5987Match = contentDisposition.match(/filename\*=UTF-8''([^;,\s]+)/i);
          if (rfc5987Match && rfc5987Match[1]) {
            try {
              filename = decodeURIComponent(rfc5987Match[1]);
            } catch {
              filename = rfc5987Match[1];
            }
          } else {
            const quotedMatch = contentDisposition.match(/filename="([^"]+)"/);
            if (quotedMatch && quotedMatch[1]) {
              filename = quotedMatch[1];
            } else {
              const unquotedMatch = contentDisposition.match(/filename=([^;,\s]+)/);
              if (unquotedMatch && unquotedMatch[1]) {
                filename = unquotedMatch[1];
              }
            }
          }
        }

        // Create blob and trigger download
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
        // Single file download - use existing endpoint
        const firstId = ids[0];
        // Type guard: ensure ID exists (even though we check ids.length === 0 at the top)
        if (!firstId) {
          return;
        }

        const file = files.find(f => f.id === firstId);
        if (file) {
          // For folders, the backend will add .zip extension
          // For files, use the actual filename with extension
          const fileName = file.name || (file.type === 'folder' ? 'folder' : 'file');
          const filename = file.type === 'folder' ? `${fileName}.zip` : fileName;
          // firstId is guaranteed to be string here due to the type guard above
          await downloadFileApi(firstId, filename);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast(errorMessage || 'Failed to download files', 'error');
    } finally {
      setIsDownloading(false);
    }
  };

  const refreshOnlyOfficeConfig = useCallback(async () => {
    // Don't refresh if user is not authenticated (check via auth state)
    // This prevents errors after logout
    if (!hasAuthState()) {
      setOnlyOfficeConfigured(false);
      return;
    }

    try {
      // Use the public endpoint that works for all users
      const result = await checkOnlyOfficeConfigured();
      setOnlyOfficeConfigured(result.configured);
    } catch {
      // Error handled silently - feature will be unavailable
      setOnlyOfficeConfigured(false);
    }
  }, []);

  // Load admin status and OnlyOffice config status on mount
  useEffect(() => {
    const loadAdminStatus = async () => {
      try {
        const status = await getSignupStatus();
        setCanConfigureOnlyOffice(status.canToggle);
      } catch {
        // Error handled silently - admin features will be unavailable
        setCanConfigureOnlyOffice(false);
      }
    };
    void loadAdminStatus();
    void refreshOnlyOfficeConfig();
  }, [refreshOnlyOfficeConfig]);

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
        createFolderModalOpen,
        imageViewerFile,
        setImageViewerFile,
        documentViewerFile,
        setDocumentViewerFile,
        shareLinkModalOpen,
        shareLinks,
        setShareLinkModalOpen,
        renameTarget,
        setRenameTarget,
        renameFile: renameFileApi,
        setCurrentPath,
        setFiles,
        setSelectedFiles,
        setViewMode,
        setSidebarOpen,
        setUploadModalOpen,
        setCreateFolderModalOpen,
        addSelectedFile,
        removeSelectedFile,
        clearSelection,
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
        sortBy,
        sortOrder,
        setSortBy,
        setSortOrder,
        searchQuery,
        setSearchQuery,
        isSearching,
        searchFiles: searchFilesApi,
        isDownloading,
        downloadFiles,
        copyFilesToPc,
        editFileWithDesktop,
        uploadProgress,
        setUploadProgress,
        uploadFileWithProgress,
        uploadFilesBulk,
        uploadFilesFromClipboard,
        setIsUploadProgressInteracting,
        onlyOfficeConfigured,
        canConfigureOnlyOffice,
        refreshOnlyOfficeConfig,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
