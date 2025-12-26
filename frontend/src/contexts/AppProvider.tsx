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
  const [uploadProgress, setUploadProgress] = useState<
    Array<{
      id: string;
      fileName: string;
      fileSize: number;
      progress: number;
      status: "uploading" | "completed" | "error";
    }>
  >([]);
  const [isUploadProgressInteracting, setIsUploadProgressInteracting] =
    useState(false);
  const isUploadProgressInteractingRef = useRef(false);
  const uploadDismissTimeoutsRef = useRef<Map<string, number>>(new Map());
  const searchQueryRef = useRef<string>(""); // Track current search query to ignore stale results
  const abortControllerRef = useRef<AbortController | null>(null); // For cancelling fetch requests
  const eventSourceRef = useRef<EventSource | null>(null); // For SSE connection
  const currentUserIdRef = useRef<string | null>(null); // Track current user ID to ignore own events
  const sseRefreshTimeoutRef = useRef<number | null>(null); // For debouncing SSE refresh
  const currentPathRef = useRef<string[]>(currentPath); // Track current path for SSE relevance check
  const folderStackRef = useRef<(string | null)[]>(folderStack); // Track folder stack for SSE relevance check
  const refreshFilesRef = useRef<
    ((skipSearchCheck?: boolean) => Promise<void>) | null
  >(null); // Track refreshFiles function for SSE

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
          setUploadProgress((prev) => {
            const itemsToKeep = prev.filter((item) => {
              if (item.status === "completed") {
                // Clean up any pending timeouts for dismissed items
                const timeout = uploadDismissTimeoutsRef.current.get(item.id);
                if (timeout) {
                  clearTimeout(timeout);
                  uploadDismissTimeoutsRef.current.delete(item.id);
                }
                return false; // Dismiss completed items
              }
              if (item.status === "error") {
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
      uploadDismissTimeoutsRef.current.forEach((timeout) => {
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

  // Fetch current user ID once on mount
  useEffect(() => {
    const fetchCurrentUserId = async () => {
      try {
        const res = await fetch("/api/auth/profile", {
          credentials: "include",
        });
        if (res.ok) {
          const user = await res.json();
          currentUserIdRef.current = user.id || null;
        }
      } catch (error) {
        console.error("Failed to fetch current user ID:", error);
      }
    };
    void fetchCurrentUserId();
  }, []);

  // Helper function to check if event is relevant (uses refs, no dependencies)
  const isEventRelevant = (
    eventType: string,
    eventData: {
      parentId?: string | null;
      id?: string;
      starred?: boolean;
      shared?: boolean;
    },
  ) => {
    const currentPage = currentPathRef.current[0];
    const currentParentId =
      folderStackRef.current[folderStackRef.current.length - 1];

    // If in Starred view, only refresh for star/unstar events
    if (currentPage === "Starred") {
      return eventData.starred !== undefined;
    }

    // If in Shared view, only refresh for share/unshare events
    if (currentPage === "Shared") {
      return eventData.shared !== undefined;
    }

    // If in Trash view, only refresh for trash-related events
    if (currentPage === "Trash") {
      return (
        eventType === "file.deleted" ||
        eventType === "file.restored" ||
        eventType === "file.permanently_deleted"
      );
    }

    // For "My Files" view, check if event's parentId matches current folder
    if (currentPage === "My Files") {
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
    const eventSource = new EventSource("/api/files/events", {
      withCredentials: true,
    });

    eventSource.onopen = () => {
      // Connection established
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle connection confirmation
        if (data.type === "connected") {
          return;
        }

        // Handle errors
        if (data.type === "error") {
          console.error("File events stream error:", data.message);
          return;
        }

        // Handle file events
        if (data.type && data.data) {
          const eventData = data.data;

          // 1. Ignore own events (if user already updated UI locally)
          if (
            currentUserIdRef.current &&
            eventData.userId === currentUserIdRef.current
          ) {
            return;
          }

          // 2. Filter by relevance - only refresh if event affects current view
          // Uses refs to get current values without causing re-renders
          if (!isEventRelevant(data.type, eventData)) {
            return;
          }

          // 3. Debounce/throttle refresh - batch multiple events
          debouncedSSERefresh();
        }
      } catch (error) {
        console.error("Failed to parse file event:", error);
      }
    };

    eventSource.onerror = (error) => {
      console.error("File events stream error:", error);
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

  const uploadFileWithProgress = async (
    file: File,
    onProgress?: (progress: number) => void,
  ) => {
    return operationQueue.add(async () => {
      return new Promise<void>((resolve, reject) => {
        const uploadId = `${Date.now()}-${Math.random()}`;
        const xhr = new XMLHttpRequest();
        const data = new FormData();
        data.append("file", file);
        const parentId = folderStack[folderStack.length - 1];
        if (parentId) data.append("parentId", parentId);

        // Add upload to progress list
        setUploadProgress((prev) => [
          ...prev,
          {
            id: uploadId,
            fileName: file.name,
            fileSize: file.size,
            progress: 0,
            status: "uploading",
          },
        ]);

        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            const progress = Math.round((e.loaded / e.total) * 100);
            setUploadProgress((prev) =>
              prev.map((item) =>
                item.id === uploadId ? { ...item, progress } : item,
              ),
            );
            if (onProgress) {
              onProgress(progress);
            }
          }
        });

        xhr.addEventListener("load", async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress((prev) =>
              prev.map((item) =>
                item.id === uploadId
                  ? { ...item, progress: 100, status: "completed" }
                  : item,
              ),
            );
            await refreshFiles();
            // Auto-dismiss after 3 seconds, but only if user is not interacting
            const dismissTimeout = setTimeout(() => {
              // Check current interaction state using ref (always up-to-date)
              if (!isUploadProgressInteractingRef.current) {
                setUploadProgress((prev) =>
                  prev.filter((item) => item.id !== uploadId),
                );
                uploadDismissTimeoutsRef.current.delete(uploadId);
              } else {
                // If user is interacting, schedule a retry
                const retryTimeout = setTimeout(() => {
                  // Check again if user stopped interacting
                  if (!isUploadProgressInteractingRef.current) {
                    setUploadProgress((prev) =>
                      prev.filter((item) => item.id !== uploadId),
                    );
                  }
                  uploadDismissTimeoutsRef.current.delete(uploadId);
                }, 2000);
                uploadDismissTimeoutsRef.current.set(uploadId, retryTimeout);
              }
            }, 3000);
            uploadDismissTimeoutsRef.current.set(uploadId, dismissTimeout);
            resolve();
          } else {
            setUploadProgress((prev) =>
              prev.map((item) =>
                item.id === uploadId ? { ...item, status: "error" } : item,
              ),
            );
            // Auto-dismiss failed uploads after 10 seconds if user is not interacting
            const errorDismissTimeout = setTimeout(() => {
              if (!isUploadProgressInteractingRef.current) {
                setUploadProgress((prev) =>
                  prev.filter((item) => item.id !== uploadId),
                );
                uploadDismissTimeoutsRef.current.delete(uploadId);
              } else {
                // If user is interacting, retry after 5 more seconds
                const retryTimeout = setTimeout(() => {
                  if (!isUploadProgressInteractingRef.current) {
                    setUploadProgress((prev) =>
                      prev.filter((item) => item.id !== uploadId),
                    );
                  }
                  uploadDismissTimeoutsRef.current.delete(uploadId);
                }, 5000);
                uploadDismissTimeoutsRef.current.set(uploadId, retryTimeout);
              }
            }, 10000); // 10 seconds for failed uploads
            uploadDismissTimeoutsRef.current.set(uploadId, errorDismissTimeout);
            reject(new Error(`Upload failed: ${xhr.statusText}`));
          }
        });

        xhr.addEventListener("error", () => {
          setUploadProgress((prev) =>
            prev.map((item) =>
              item.id === uploadId ? { ...item, status: "error" } : item,
            ),
          );
          // Auto-dismiss failed uploads after 10 seconds if user is not interacting
          const errorDismissTimeout = setTimeout(() => {
            if (!isUploadProgressInteractingRef.current) {
              setUploadProgress((prev) =>
                prev.filter((item) => item.id !== uploadId),
              );
              uploadDismissTimeoutsRef.current.delete(uploadId);
            } else {
              // If user is interacting, retry after 5 more seconds
              const retryTimeout = setTimeout(() => {
                if (!isUploadProgressInteractingRef.current) {
                  setUploadProgress((prev) =>
                    prev.filter((item) => item.id !== uploadId),
                  );
                }
                uploadDismissTimeoutsRef.current.delete(uploadId);
              }, 5000);
              uploadDismissTimeoutsRef.current.set(uploadId, retryTimeout);
            }
          }, 10000); // 10 seconds for failed uploads
          uploadDismissTimeoutsRef.current.set(uploadId, errorDismissTimeout);
          reject(new Error("Upload failed"));
        });

        xhr.addEventListener("abort", () => {
          setUploadProgress((prev) =>
            prev.filter((item) => item.id !== uploadId),
          );
          reject(new Error("Upload cancelled"));
        });

        xhr.open("POST", `/api/files/upload`);
        xhr.withCredentials = true;
        xhr.send(data);
      });
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
        uploadProgress,
        setUploadProgress,
        uploadFileWithProgress,
        setIsUploadProgressInteracting,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
