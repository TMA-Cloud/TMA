import React, { createContext, useContext, useState, useEffect } from "react";

export interface FileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  size?: number;
  modified: Date;
  mimeType?: string;
  selected?: boolean;
  starred?: boolean;
  shared?: boolean;
}

interface AppContextType {
  currentPath: string[];
  folderStack: (string | null)[];
  folderSharedStack: boolean[];
  files: FileItem[];
  selectedFiles: string[];
  viewMode: "grid" | "list";
  sidebarOpen: boolean;
  uploadModalOpen: boolean;
  createFolderModalOpen: boolean;
  imageViewerFile: FileItem | null;
  setImageViewerFile: (file: FileItem | null) => void;
  shareLinkModalOpen: boolean;
  shareLinks: string[];
  setShareLinkModalOpen: (open: boolean, links?: string[]) => void;
  renameTarget: FileItem | null;
  setRenameTarget: (file: FileItem | null) => void;
  renameFile: (id: string, name: string) => Promise<void>;
  setCurrentPath: (path: string[], ids?: (string | null)[]) => void;
  setFiles: (files: FileItem[]) => void;
  setSelectedFiles: (ids: string[]) => void;
  setViewMode: (mode: "grid" | "list") => void;
  setSidebarOpen: (open: boolean) => void;
  setUploadModalOpen: (open: boolean) => void;
  setCreateFolderModalOpen: (open: boolean) => void;
  addSelectedFile: (id: string) => void;
  removeSelectedFile: (id: string) => void;
  clearSelection: () => void;
  refreshFiles: () => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  moveFiles: (ids: string[], parentId: string | null) => Promise<void>;
  copyFiles: (ids: string[], parentId: string | null) => Promise<void>;
  shareFiles: (
    ids: string[],
    shared: boolean,
  ) => Promise<Record<string, string>>;
  linkToParentShare: (ids: string[]) => Promise<Record<string, string>>;
  starFiles: (ids: string[], starred: boolean) => Promise<void>;
  clipboard: { ids: string[]; action: "copy" | "cut" } | null;
  setClipboard: (
    clip: { ids: string[]; action: "copy" | "cut" } | null,
  ) => void;
  pasteClipboard: (parentId: string | null) => Promise<void>;
  pasteProgress: number | null;
  setPasteProgress: (p: number | null) => void;
  openFolder: (folder: FileItem) => void;
  navigateTo: (index: number) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
};

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
  const [viewMode, setViewMode] = useState<"grid" | "list">("list"); // Changed default to 'list'
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

  const refreshFiles = async () => {
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
      } else {
        url = new URL(url);
        if (parentId) url.searchParams.append("parentId", parentId);
        url = url.toString();
      }
      const res = await fetch(url.toString(), { credentials: "include" });
      const data = await res.json();
      setFiles(
        data.map((f: any) => ({
          ...f,
          modified: new Date(f.modified),
        })),
      );
    } catch (e) {
      console.error("Failed to load files", e);
    }
  };

  useEffect(() => {
    refreshFiles();
  }, [folderStack]);

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
  };

  const moveFiles = async (ids: string[], parentId: string | null) => {
    await fetch(`${import.meta.env.VITE_API_URL}/api/files/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids, parentId }),
    });
    await refreshFiles();
  };

  const copyFilesApi = async (ids: string[], parentId: string | null) => {
    await fetch(`${import.meta.env.VITE_API_URL}/api/files/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids, parentId }),
    });
    await refreshFiles();
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
    setPasteProgress(0);
    const total = clipboard.ids.length;
    for (let i = 0; i < total; i++) {
      const id = clipboard.ids[i];
      const endpoint = clipboard.action === "cut" ? "move" : "copy";
      await fetch(`${import.meta.env.VITE_API_URL}/api/files/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids: [id], parentId }),
      });
      setPasteProgress(Math.round(((i + 1) / total) * 100));
    }
    await refreshFiles();
    setClipboard(null);
    setTimeout(() => setPasteProgress(null), 300);
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
        clipboard,
        setClipboard,
        pasteClipboard,
        pasteProgress,
        setPasteProgress,
        openFolder,
        navigateTo,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
