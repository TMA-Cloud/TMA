import { createContext, useContext } from "react";

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
  deletedAt?: Date;
}

// FileItemResponse moved to provider implementation

export interface AppContextType {
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
  deleteFiles: (ids: string[]) => Promise<void>;
  deleteForever: (ids: string[]) => Promise<void>;
  clipboard: { ids: string[]; action: "copy" | "cut" } | null;
  setClipboard: (
    clip: { ids: string[]; action: "copy" | "cut" } | null,
  ) => void;
  pasteClipboard: (parentId: string | null) => Promise<void>;
  pasteProgress: number | null;
  setPasteProgress: (p: number | null) => void;
  openFolder: (folder: FileItem) => void;
  navigateTo: (index: number) => void;
  sortBy: "name" | "size" | "modified" | "deletedAt";
  sortOrder: "asc" | "desc";
  setSortBy: (s: "name" | "size" | "modified" | "deletedAt") => void;
  setSortOrder: (o: "asc" | "desc") => void;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
};

// Moved AppProvider to ./AppProvider.tsx so this file only exports hooks/types
