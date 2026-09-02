import { useCallback, useEffect, useRef, useState } from 'react';
import { type FileItem, type FileItemResponse, type FileSortBy } from '../AppContext';
import { useDebouncedCallback } from '../../utils/debounce';
import { mapFileResponse } from '../../utils/fileUtils';
import { isFileManagerPage, sortFilesWithFoldersFirst, type NavEntry } from './helpers';

/** Location, navigation history, listing (with sort), and search — one concern. */
export function useFileBrowser(setSelectedFiles: (ids: string[]) => void) {
  // State

  const [currentPath, setCurrentPathState] = useState<string[]>(['My Files']);
  const [folderStack, setFolderStack] = useState<(string | null)[]>([null]);
  const [folderSharedStack, setFolderSharedStack] = useState<boolean[]>([false]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [sortBy, setSortBy] = useState<FileSortBy>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [navHistory, setNavHistory] = useState<{ entries: NavEntry[]; index: number }>(() => ({
    entries: [{ path: ['My Files'], ids: [null], shared: [false] }],
    index: 0,
  }));

  // Refs

  const searchQueryRef = useRef('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const listRefreshControllerRef = useRef<AbortController | null>(null);
  const listRefreshSeqRef = useRef(0);
  const filesRef = useRef<FileItem[]>(files);
  const filesBeforeSearchRef = useRef<FileItem[] | null>(null);
  const didSavePreSearchRef = useRef(false);
  const currentPathRef = useRef<string[]>(currentPath);
  const folderStackRef = useRef<(string | null)[]>(folderStack);
  const folderSharedStackRef = useRef<boolean[]>(folderSharedStack);
  const refreshFilesRef = useRef<((skipSearchCheck?: boolean) => Promise<void>) | null>(null);
  const returnHighlightAfterRefreshRef = useRef<string | null>(null);

  // Ref-sync effects

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

      // Abort any prior listing so a slow response for an old folder can't win.
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
    [folderStack, currentPath, sortBy, sortOrder, searchQuery, setSelectedFiles]
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

  const refreshOrResearch = useCallback(async () => {
    const activeQuery = searchQueryRef.current.trim();
    if (activeQuery) {
      await searchFilesApi(activeQuery);
    } else {
      await refreshFiles();
    }
  }, [searchFilesApi, refreshFiles]);

  // Search effect

  // The listing effect below re-lists whenever searchQuery goes empty.
  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      if (!didSavePreSearchRef.current) {
        filesBeforeSearchRef.current = filesRef.current;
        didSavePreSearchRef.current = true;
      }
      debouncedSearch(searchQuery);
      return;
    }

    // Only tear down if a search was actually running.
    if (!didSavePreSearchRef.current) return;

    cancelSearch();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    Promise.resolve().then(() => {
      setIsSearching(false);
      // Pages with no folder to re-fetch get their pre-search contents restored.
      if (!isFileManagerPage(currentPathRef.current[0]) && filesBeforeSearchRef.current) {
        setFiles(filesBeforeSearchRef.current);
      }
      filesBeforeSearchRef.current = null;
      didSavePreSearchRef.current = false;
    });
  }, [searchQuery, debouncedSearch, cancelSearch]);

  // Single owner of what the current view lists (folder/page/sort/leaving search).
  useEffect(() => {
    if (searchQuery.trim().length === 0 && isFileManagerPage(currentPath[0])) {
      Promise.resolve().then(() => refreshFiles(true));
    }
  }, [currentPath, searchQuery, refreshFiles]);

  // Navigation

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

  return {
    // Listing state
    files,
    setFiles,
    sortBy,
    sortOrder,
    setSortBy,
    setSortOrder,
    refreshFiles,
    debouncedRefreshFiles,
    refreshOrResearch,

    // Navigation state
    currentPath,
    folderStack,
    folderSharedStack,
    setCurrentPath,
    openFolder,
    navigateTo,
    canGoBack,
    canGoForward,
    goBack,
    goForward,

    // Search state
    searchQuery,
    setSearchQuery,
    isSearching,
    searchFiles: searchFilesApi,

    // Refs shared with sibling hooks (uploads, operations, clipboard, SSE)
    currentPathRef,
    folderStackRef,
    folderSharedStackRef,
    refreshFilesRef,
  };
}
