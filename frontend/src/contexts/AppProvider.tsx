import React, { useCallback, useEffect, useState, useRef } from "react";
import { AppContext, type FileItem, type FileItemResponse } from "./AppContext";
import { usePromiseQueue, useDebouncedCallback } from "../utils/debounce";
import { downloadFile as downloadFileApi } from "../utils/api";

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [currentPath, setCurrentPathState] = useState<string[]>(["My Files"]);
  const [folderStack, setFolderStack] = useState<(string | null)[]>([null]);
  const [folderSharedStack, setFolderSharedStack] = useState<boolean[]>([
    false,
  ]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false);
  const [imageViewerFile, setImageViewerFile] = useState<FileItem | null>(null);
  const [documentViewerFile, setDocumentViewerFile] = useState<FileItem | null>(
    null,
  );
  const [shareLinkModalOpen, setShareLinkModalOpenState] = useState(false);
  const [shareLinks, setShareLinks] = useState<string[]>([]);
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [clipboard, setClipboard] = useState<{
    ids: string[];
    action: "copy" | "cut";
  } | null>(null);
  const [pasteProgress, setPasteProgress] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<
    "name" | "size" | "modified" | "deletedAt"
  >("modified");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const searchQueryRef = useRef<string>(""); // Track current search query to ignore stale results
  const abortControllerRef = useRef<AbortController | null>(null); // For cancelling fetch requests

  const operationQueue = usePromiseQueue();

  // Keep ref in sync with state
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  // Helper to build a map of fileId -> full share URL from the backend response.
  // Backend now returns full URLs in `links`.
  const buildShareUrlMap = useCallback(
    (data: { links?: Record<string, string> }) => {
      const urls: Record<string, string> = {};
      const linkMap = data?.links || {};
      for (const [id, url] of Object.entries(linkMap)) {
        if (typeof url === "string" && url.trim()) {
          urls[id] = url;
        }
      }
      return urls;
    },
    [],
  );

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
          currentPage === "My Files" ||
          currentPage === "Shared" ||
          currentPage === "Starred" ||
          currentPage === "Trash";

        if (!isFileManagerPage) {
          return;
        }

        const parentId = folderStack[folderStack.length - 1];
        let urlPath = `/api/files`;
        if (currentPath[0] === "Starred" && folderStack.length === 1) {
          urlPath = `/api/files/starred`;
        } else if (currentPath[0] === "Shared" && folderStack.length === 1) {
          urlPath = `/api/files/shared`;
        } else if (currentPath[0] === "Trash" && folderStack.length === 1) {
          urlPath = `/api/files/trash`;
        }

        const url = new URL(urlPath, window.location.origin);
        if (parentId) url.searchParams.append("parentId", parentId);
        url.searchParams.append("sortBy", sortBy);
        // Only append order if it has a valid value, and convert to uppercase for backend
        if (sortOrder && sortOrder.trim()) {
          url.searchParams.append("order", sortOrder.toUpperCase());
        }
        const res = await fetch(url.toString(), { credentials: "include" });
        const data: FileItemResponse[] = await res.json();
        setFiles(
          data.map((f) => ({
            ...f,
            modified: new Date(f.modified),
            deletedAt: f.deletedAt ? new Date(f.deletedAt) : undefined,
          })),
        );
      } catch (e) {
        console.error("Failed to load files", e);
      }
    },
    [folderStack, currentPath, sortBy, sortOrder, searchQuery],
  );

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
        url.searchParams.append("q", trimmedQuery);
        url.searchParams.append("limit", "100");

        const res = await fetch(url.toString(), {
          credentials: "include",
          signal: abortController.signal, // Enable request cancellation
        });

        // Check if request was aborted
        if (abortController.signal.aborted) {
          return;
        }

        if (!res.ok) {
          throw new Error("Search failed");
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

        setFiles(
          data.map((f) => ({
            ...f,
            modified: new Date(f.modified),
            deletedAt: f.deletedAt ? new Date(f.deletedAt) : undefined,
          })),
        );
      } catch (e) {
        // Ignore abort errors (expected when cancelling)
        if (e instanceof Error && e.name === "AbortError") {
          return;
        }

        // Only update state if query is still relevant and not aborted
        if (
          searchQueryRef.current.trim() === trimmedQuery &&
          !abortController.signal.aborted
        ) {
          console.error("Failed to search files", e);
          setFiles([]);
        }
      } finally {
        // Only update searching state if query is still relevant and controller wasn't replaced
        if (
          searchQueryRef.current.trim() === trimmedQuery &&
          abortControllerRef.current === abortController
        ) {
          setIsSearching(false);
          abortControllerRef.current = null;
        }
      }
    },
    [refreshFiles],
  );

  // Debounced search function with cancellation support
  const [debouncedSearch, cancelSearch] = useDebouncedCallback(
    searchFilesApi,
    300,
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

  useEffect(() => {
    // Only refresh files when not searching and searchQuery is empty
    // Also check if we're on a file manager page to avoid unnecessary calls
    const currentPage = currentPath[0];
    const isFileManagerPage =
      currentPage === "My Files" ||
      currentPage === "Shared" ||
      currentPage === "Starred" ||
      currentPage === "Trash";

    if (searchQuery.trim().length === 0 && isFileManagerPage) {
      void refreshFiles(true); // Force refresh when navigating/filtering
    }
  }, [folderStack, currentPath, sortBy, sortOrder, searchQuery, refreshFiles]);

  const createFolder = async (name: string) => {
    try {
      const res = await fetch(`/api/files/folder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name,
          parentId: folderStack[folderStack.length - 1],
        }),
      });
      if (!res.ok) {
        throw new Error("Failed to create folder");
      }
      await refreshFiles();
    } catch (error) {
      console.error("Failed to create folder:", error);
      throw error;
    }
  };

  const uploadFile = async (file: File) => {
    return operationQueue.add(async () => {
      try {
        const data = new FormData();
        data.append("file", file);
        const parentId = folderStack[folderStack.length - 1];
        if (parentId) data.append("parentId", parentId);
        await fetch(`/api/files/upload`, {
          method: "POST",
          credentials: "include",
          body: data,
        });
        await refreshFiles();
      } catch (error) {
        console.error("Upload failed", error);
        throw error;
      }
    });
  };

  const moveFiles = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      try {
        const res = await fetch(`/api/files/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ids, parentId }),
        });
        if (!res.ok) {
          throw new Error("Failed to move files");
        }
        await refreshFiles();
      } catch (error) {
        console.error("Failed to move files:", error);
        throw error;
      }
    });
  };

  const copyFilesApi = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      try {
        const res = await fetch(`/api/files/copy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ids, parentId }),
        });
        if (!res.ok) {
          throw new Error("Failed to copy files");
        }
        await refreshFiles();
      } catch (error) {
        console.error("Failed to copy files:", error);
        throw error;
      }
    });
  };

  const renameFileApi = async (id: string, name: string) => {
    try {
      const res = await fetch(`/api/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id, name }),
      });
      if (!res.ok) {
        throw new Error("Failed to rename file");
      }
      await refreshFiles();
    } catch (error) {
      console.error("Failed to rename file:", error);
      throw error;
    }
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
  ): Promise<Record<string, string>> => {
    try {
      const res = await fetch(`/api/files/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids, shared }),
      });
      if (!res.ok) {
        throw new Error("Failed to share files");
      }
      const data = await res.json();
      const links = buildShareUrlMap(data);
      await refreshFiles();
      return links;
    } catch (error) {
      console.error("Failed to share files:", error);
      throw error;
    }
  };

  const getShareLinks = async (
    ids: string[],
  ): Promise<Record<string, string>> => {
    try {
      const res = await fetch(`/api/files/share/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        throw new Error("Failed to get share links");
      }
      const data = await res.json();
      return buildShareUrlMap(data);
    } catch (error) {
      console.error("Failed to get share links:", error);
      throw error;
    }
  };

  const starFilesApi = async (ids: string[], starred: boolean) => {
    try {
      const res = await fetch(`/api/files/star`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids, starred }),
      });
      if (!res.ok) {
        throw new Error("Failed to update star status");
      }
      await refreshFiles();
    } catch (error) {
      console.error("Failed to update star status:", error);
      throw error;
    }
  };

  const deleteFilesApi = async (ids: string[]) => {
    try {
      const res = await fetch(`/api/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        throw new Error("Failed to delete files");
      }
      await refreshFiles();
    } catch (error) {
      console.error("Failed to delete files:", error);
      throw error;
    }
  };

  const restoreFilesApi = async (ids: string[]) => {
    const res = await fetch(`/api/files/trash/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    await refreshFiles();
    if (!res.ok) {
      throw new Error(data.message || "Failed to restore files");
    }
    return data;
  };

  const deleteForeverApi = async (ids: string[]) => {
    try {
      const res = await fetch(`/api/files/trash/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        throw new Error("Failed to permanently delete files");
      }
      await refreshFiles();
    } catch (error) {
      console.error("Failed to permanently delete files:", error);
      throw error;
    }
  };

  const emptyTrashApi = async () => {
    const res = await fetch(`/api/files/trash/empty`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const data = await res.json();
    await refreshFiles();
    if (!res.ok) {
      throw new Error(data.message || "Failed to empty trash");
    }
    return data;
  };

  const linkToParentShareApi = async (
    ids: string[],
  ): Promise<Record<string, string>> => {
    try {
      const res = await fetch(`/api/files/link-parent-share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        throw new Error("Failed to link to parent share");
      }
      const data = await res.json();
      await refreshFiles();
      return buildShareUrlMap(data);
    } catch (error) {
      console.error("Failed to link to parent share:", error);
      throw error;
    }
  };

  const pasteClipboard = async (parentId: string | null) => {
    if (!clipboard) return;

    return operationQueue.add(async () => {
      setPasteProgress(0);
      const endpoint = clipboard.action === "cut" ? "move" : "copy";

      try {
        await fetch(`/api/files/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ids: clipboard.ids, parentId }),
        });

        setPasteProgress(100);
        await refreshFiles();
        setClipboard(null);
        setTimeout(() => setPasteProgress(null), 300);
      } catch (error) {
        console.error("Paste operation failed", error);
        setPasteProgress(null);
        throw error;
      }
    });
  };

  const addSelectedFile = (id: string) => {
    setSelectedFiles((prev) => [...prev, id]);
  };

  const removeSelectedFile = (id: string) => {
    setSelectedFiles((prev) => prev.filter((fileId) => fileId !== id));
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
      setSearchQuery("");
    }
    setCurrentPathState((p) => [...p, folder.name]);
    setFolderStack((p) => [...p, folder.id]);
    setFolderSharedStack((p) => [...p, !!folder.shared]);
  };

  const navigateTo = (index: number) => {
    setCurrentPathState((p) => p.slice(0, index + 1));
    setFolderStack((p) => p.slice(0, index + 1));
    setFolderSharedStack((p) => p.slice(0, index + 1));
  };

  const downloadFiles = async (ids: string[]) => {
    if (isDownloading || ids.length === 0) return;

    setIsDownloading(true);
    try {
      // Download files sequentially to avoid overwhelming the server
      for (const id of ids) {
        const file = files.find((f) => f.id === id);
        if (file) {
          // For folders, the backend will add .zip extension
          // For files, use the actual filename with extension
          const filename =
            file.type === "folder" ? `${file.name}.zip` : file.name;
          await downloadFileApi(id, filename);
        }
      }
    } catch (error) {
      console.error("Download failed", error);
      // Error is already logged, user will see download failure in browser
    } finally {
      setIsDownloading(false);
    }
  };

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
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
