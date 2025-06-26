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
  files: FileItem[];
  selectedFiles: string[];
  viewMode: "grid" | "list";
  sidebarOpen: boolean;
  uploadModalOpen: boolean;
  setCurrentPath: (path: string[]) => void;
  setFiles: (files: FileItem[]) => void;
  setSelectedFiles: (ids: string[]) => void;
  setViewMode: (mode: "grid" | "list") => void;
  setSidebarOpen: (open: boolean) => void;
  setUploadModalOpen: (open: boolean) => void;
  addSelectedFile: (id: string) => void;
  removeSelectedFile: (id: string) => void;
  clearSelection: () => void;
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
  const [currentPath, setCurrentPath] = useState<string[]>(["My Files"]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("list"); // Changed default to 'list'
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  useEffect(() => {
    const fetchFiles = async () => {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/api/files`);
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
    fetchFiles();
  }, []);

  const addSelectedFile = (id: string) => {
    setSelectedFiles((prev) => [...prev, id]);
  };

  const removeSelectedFile = (id: string) => {
    setSelectedFiles((prev) => prev.filter((fileId) => fileId !== id));
  };

  const clearSelection = () => {
    setSelectedFiles([]);
  };

  return (
    <AppContext.Provider
      value={{
        currentPath,
        files,
        selectedFiles,
        viewMode,
        sidebarOpen,
        uploadModalOpen,
        setCurrentPath,
        setFiles,
        setSelectedFiles,
        setViewMode,
        setSidebarOpen,
        setUploadModalOpen,
        addSelectedFile,
        removeSelectedFile,
        clearSelection,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
