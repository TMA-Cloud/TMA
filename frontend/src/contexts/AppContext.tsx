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
  files: FileItem[];
  selectedFiles: string[];
  viewMode: "grid" | "list";
  sidebarOpen: boolean;
  uploadModalOpen: boolean;
  createFolderModalOpen: boolean;
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
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("list"); // Changed default to 'list'
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false);

  const refreshFiles = async () => {
    try {
      const parentId = folderStack[folderStack.length - 1];
      const url = new URL(`${import.meta.env.VITE_API_URL}/api/files`);
      if (parentId) url.searchParams.append("parentId", parentId);
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
    } else {
      setFolderStack(Array(path.length).fill(null));
    }
  };

  const openFolder = (folder: FileItem) => {
    setCurrentPathState((p) => [...p, folder.name]);
    setFolderStack((p) => [...p, folder.id]);
  };

  const navigateTo = (index: number) => {
    setCurrentPathState((p) => p.slice(0, index + 1));
    setFolderStack((p) => p.slice(0, index + 1));
  };

  return (
    <AppContext.Provider
      value={{
        currentPath,
        folderStack,
        files,
        selectedFiles,
        viewMode,
        sidebarOpen,
        uploadModalOpen,
        createFolderModalOpen,
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
        openFolder,
        navigateTo,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
