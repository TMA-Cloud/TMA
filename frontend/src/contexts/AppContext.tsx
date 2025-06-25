import React, { createContext, useContext, useState } from "react";

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

const generateMockFiles = (): FileItem[] => [
  {
    id: "1",
    name: "Documents",
    type: "folder",
    modified: new Date("2024-01-15"),
    starred: true,
  },
  { id: "2", name: "Photos", type: "folder", modified: new Date("2024-01-14") },
  {
    id: "3",
    name: "Projects",
    type: "folder",
    modified: new Date("2024-01-13"),
    shared: true,
  },
  {
    id: "4",
    name: "presentation.pptx",
    type: "file",
    size: 2457600,
    modified: new Date("2024-01-12"),
    mimeType: "application/vnd.ms-powerpoint",
    starred: true,
  },
  {
    id: "5",
    name: "report.pdf",
    type: "file",
    size: 1024000,
    modified: new Date("2024-01-11"),
    mimeType: "application/pdf",
  },
  {
    id: "6",
    name: "vacation.jpg",
    type: "file",
    size: 3145728,
    modified: new Date("2024-01-10"),
    mimeType: "image/jpeg",
  },
  {
    id: "7",
    name: "budget.xlsx",
    type: "file",
    size: 512000,
    modified: new Date("2024-01-09"),
    mimeType: "application/vnd.ms-excel",
  },
  {
    id: "8",
    name: "notes.txt",
    type: "file",
    size: 4096,
    modified: new Date("2024-01-08"),
    mimeType: "text/plain",
  },
];

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [currentPath, setCurrentPath] = useState<string[]>(["My Files"]);
  const [files, setFiles] = useState<FileItem[]>(generateMockFiles());
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("list"); // Changed default to 'list'
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

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
