import { createContext, useContext } from 'react';
import type { UploadProgressItem } from '../utils/uploadUtils';

export type ShareExpiry = '7d' | '30d' | 'never';

export interface FolderInfo {
  totalSize: number;
  fileCount: number;
  folderCount: number;
}

export interface FileItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  modified: Date;
  mimeType?: string;
  selected?: boolean;
  starred?: boolean;
  shared?: boolean;
  deletedAt?: Date;
  expiresAt?: Date | null;
  folderInfo?: FolderInfo;
}

export interface FileItemResponse {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  modified: string;
  mimeType?: string;
  selected?: boolean;
  starred?: boolean;
  shared?: boolean;
  deletedAt?: string | null;
  expiresAt?: string | null;
}

export interface BulkUploadEntry {
  file: File;
  /**
   * Relative path (e.g. "MyFolder/sub/file.txt") used to recreate folder structure server-side.
   * When omitted, the file is uploaded into the current folder.
   */
  relativePath?: string;
  /** Client-generated id to map progress updates to backend results. */
  clientId?: string;
}

/** Entry passed when opening the upload modal via drag-and-drop (e.g. from file manager). */
export type UploadModalInitialEntry = { file: File; relativePath?: string };

export interface AppContextType {
  currentPath: string[];
  folderStack: (string | null)[];
  folderSharedStack: boolean[];
  files: FileItem[];
  selectedFiles: string[];
  viewMode: 'grid' | 'list';
  sidebarOpen: boolean;
  uploadModalOpen: boolean;
  createFolderModalOpen: boolean;
  imageViewerFile: FileItem | null;
  setImageViewerFile: (file: FileItem | null) => void;
  documentViewerFile?: FileItem | null;
  setDocumentViewerFile?: (file: FileItem | null) => void;
  shareLinkModalOpen: boolean;
  shareLinks: string[];
  setShareLinkModalOpen: (open: boolean, links?: string[]) => void;
  renameTarget: FileItem | null;
  setRenameTarget: (file: FileItem | null) => void;
  renameFile: (id: string, name: string) => Promise<void>;
  setCurrentPath: (path: string[], ids?: (string | null)[]) => void;
  setFiles: (files: FileItem[]) => void;
  setSelectedFiles: (ids: string[]) => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  setSidebarOpen: (open: boolean) => void;
  setUploadModalOpen: (open: boolean) => void;
  /** Initial entries when opening the modal from a drop (e.g. drag onto file manager). Cleared after modal consumes. */
  uploadModalInitialEntries: UploadModalInitialEntry[] | null;
  /** Open upload modal and pre-fill with these entries (from drag-and-drop). */
  openUploadModalWithEntries: (entries: UploadModalInitialEntry[]) => void;
  /** Clear initial entries after modal has consumed them. */
  clearUploadModalInitialEntries: () => void;
  setCreateFolderModalOpen: (open: boolean) => void;
  addSelectedFile: (id: string) => void;
  removeSelectedFile: (id: string) => void;
  clearSelection: () => void;
  refreshFiles: () => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  moveFiles: (ids: string[], parentId: string | null) => Promise<void>;
  copyFiles: (ids: string[], parentId: string | null) => Promise<void>;
  shareFiles: (ids: string[], shared: boolean, expiry?: ShareExpiry) => Promise<Record<string, string>>;
  getShareLinks: (ids: string[]) => Promise<Record<string, string>>;
  linkToParentShare: (ids: string[]) => Promise<Record<string, string>>;
  starFiles: (ids: string[], starred: boolean) => Promise<void>;
  deleteFiles: (ids: string[]) => Promise<void>;
  restoreFiles: (ids: string[]) => Promise<{ success: boolean; message?: string }>;
  deleteForever: (ids: string[]) => Promise<void>;
  emptyTrash: () => Promise<{ success: boolean; message?: string }>;
  clipboard: { ids: string[]; action: 'copy' | 'cut' } | null;
  setClipboard: (clip: { ids: string[]; action: 'copy' | 'cut' } | null) => void;
  pasteClipboard: (parentId: string | null) => Promise<void>;
  pasteProgress: number | null;
  setPasteProgress: (p: number | null) => void;
  openFolder: (folder: FileItem) => void;
  navigateTo: (index: number) => void;
  /** Folder navigation history (Electron: back/forward). */
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  sortBy: 'name' | 'size' | 'modified' | 'deletedAt';
  sortOrder: 'asc' | 'desc';
  setSortBy: (s: 'name' | 'size' | 'modified' | 'deletedAt') => void;
  setSortOrder: (o: 'asc' | 'desc') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  isSearching: boolean;
  searchFiles: (query: string) => Promise<void>;
  isDownloading: boolean;
  downloadFiles: (ids: string[]) => Promise<void>;
  /** Copy selected files to OS clipboard so user can paste in Explorer (Electron only). */
  copyFilesToPc: (ids: string[]) => Promise<void>;
  /** Open a single file on the desktop (Windows) and save changes back */
  editFileWithDesktop: (id: string) => Promise<void>;
  uploadProgress: UploadProgressItem[];
  setUploadProgress: (progress: UploadProgressItem[] | ((prev: UploadProgressItem[]) => UploadProgressItem[])) => void;
  uploadFileWithProgress: (file: File, onProgress?: (progress: number) => void) => Promise<void>;
  /** Replace contents of an existing file (same progress UI as upload). */
  replaceFileWithProgress: (fileId: string, file: File, onProgress?: (progress: number) => void) => Promise<void>;
  uploadFilesBulk: (files: File[]) => Promise<void>;
  uploadEntriesBulk: (entries: BulkUploadEntry[]) => Promise<void>;
  /** Upload files from OS clipboard (Electron only). */
  uploadFilesFromClipboard: () => Promise<void>;
  setIsUploadProgressInteracting: (isInteracting: boolean) => void;
  onlyOfficeConfigured: boolean;
  canConfigureOnlyOffice: boolean;
  refreshOnlyOfficeConfig: () => Promise<void>;
  /** When true, file names are shown without extensions (admin setting). */
  hideFileExtensions: boolean;
  /** Update hide file extensions (used after admin changes setting). */
  setHideFileExtensions: (hidden: boolean) => void;
  updatesAvailable: {
    frontend?: string;
    backend?: string;
    electron?: string;
  } | null;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};

// Moved AppProvider to ./AppProvider.tsx so this file only exports hooks/types
