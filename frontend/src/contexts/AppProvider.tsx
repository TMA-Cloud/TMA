import React, { useCallback, useEffect, useState } from "react";
import { AppContext, FileItem, FileItemResponse } from "./AppContext";
import { usePromiseQueue } from "../utils/debounce";

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

  const operationQueue = usePromiseQueue();

  const refreshFiles = useCallback(async () => {
    try {
      const parentId = folderStack[folderStack.length - 1];
      let url: string | URL = `${import.meta.env.VITE_API_URL}/api/files`;
      if (currentPath[0] === "Starred" && folderStack.length === 1) {
        url = `${import.meta.env.VITE_API_URL}/api/files/starred`;
      } else if (
        currentPath[0] === "Shared with Me" &&
        folderStack.length === 1
      ) {
        url = `${import.meta.env.VITE_API_URL}/api/files/shared`;
      } else if (currentPath[0] === "Trash" && folderStack.length === 1) {
        url = `${import.meta.env.VITE_API_URL}/api/files/trash`;
      }

      url = new URL(url as string);
      if (parentId) url.searchParams.append("parentId", parentId);
      url.searchParams.append("sortBy", sortBy);
      url.searchParams.append("order", sortOrder);
      url = url.toString();
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
  }, [folderStack, currentPath, sortBy, sortOrder]);

  useEffect(() => {
    const id = setTimeout(() => {
      void refreshFiles();
    }, 0);
    return () => clearTimeout(id);
  }, [refreshFiles]);

  const createFolder = async (name: string) => {
    await fetch(`${import.meta.env.VITE_API_URL}/api/files/folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        name,
        parentId: folderStack[folderStack.length - 1],
      }),
    });
    await refreshFiles();
  };

  const uploadFile = async (file: File) => {
    return operationQueue.add(async () => {
      try {
        const data = new FormData();
        data.append("file", file);
        const parentId = folderStack[folderStack.length - 1];
        if (parentId) data.append("parentId", parentId);
        await fetch(`${import.meta.env.VITE_API_URL}/api/files/upload`, {
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
      await fetch(`${import.meta.env.VITE_API_URL}/api/files/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids, parentId }),
      });
      await refreshFiles();
    });
  };

  const copyFilesApi = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      await fetch(`${import.meta.env.VITE_API_URL}/api/files/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids, parentId }),
      });
      await refreshFiles();
    });
  };

  const renameFileApi = async (id: string, name: string) => {
    await fetch(`${import.meta.env.VITE_API_URL}/api/files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id, name }),
    });
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
  ): Promise<Record<string, string>> => {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/files/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids, shared }),
    });
    const data = await res.json();
    await refreshFiles();
    return data.links || {};
  };

  const starFilesApi = async (ids: string[], starred: boolean) => {
    await fetch(`${import.meta.env.VITE_API_URL}/api/files/star`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids, starred }),
    });
    await refreshFiles();
  };

  const deleteFilesApi = async (ids: string[]) => {
    await fetch(`${import.meta.env.VITE_API_URL}/api/files/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids }),
    });
    await refreshFiles();
  };

  const deleteForeverApi = async (ids: string[]) => {
    await fetch(`${import.meta.env.VITE_API_URL}/api/files/trash/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids }),
    });
    await refreshFiles();
  };

  const linkToParentShareApi = async (
    ids: string[],
  ): Promise<Record<string, string>> => {
    const res = await fetch(
      `${import.meta.env.VITE_API_URL}/api/files/link-parent-share`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      },
    );
    const data = await res.json();
    await refreshFiles();
    return data.links || {};
  };

  const pasteClipboard = async (parentId: string | null) => {
    if (!clipboard) return;

    return operationQueue.add(async () => {
      setPasteProgress(0);
      const endpoint = clipboard.action === "cut" ? "move" : "copy";

      try {
        await fetch(`${import.meta.env.VITE_API_URL}/api/files/${endpoint}`, {
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
    setCurrentPathState((p) => [...p, folder.name]);
    setFolderStack((p) => [...p, folder.id]);
    setFolderSharedStack((p) => [...p, !!folder.shared]);
  };

  const navigateTo = (index: number) => {
    setCurrentPathState((p) => p.slice(0, index + 1));
    setFolderStack((p) => p.slice(0, index + 1));
    setFolderSharedStack((p) => p.slice(0, index + 1));
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
        linkToParentShare: linkToParentShareApi,
        starFiles: starFilesApi,
        deleteFiles: deleteFilesApi,
        deleteForever: deleteForeverApi,
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
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
