import { useState } from 'react';
import type { FileItem, UploadModalInitialEntry } from '../AppContext';

/** Plain UI state: selection, view toggles, and modal open/target flags. No business logic. */
export function useUiState() {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadModalProcessing, setUploadModalProcessing] = useState(false);
  const [uploadModalProcessingRequestId, setUploadModalProcessingRequestId] = useState<string | null>(null);
  const [uploadScanCount, setUploadScanCount] = useState(0);
  const [uploadModalInitialEntries, setUploadModalInitialEntries] = useState<UploadModalInitialEntry[] | null>(null);

  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false);
  const [imageViewerFile, setImageViewerFile] = useState<FileItem | null>(null);
  const [documentViewerFile, setDocumentViewerFile] = useState<FileItem | null>(null);
  const [shareLinkModalOpen, setShareLinkModalOpenState] = useState(false);
  const [shareLinks, setShareLinks] = useState<string[]>([]);
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);

  return {
    // Selection
    selectedFiles,
    setSelectedFiles,
    addSelectedFile: (id: string) => setSelectedFiles(prev => [...prev, id]),
    removeSelectedFile: (id: string) => setSelectedFiles(prev => prev.filter(fId => fId !== id)),
    clearSelection: () => setSelectedFiles([]),

    // View
    viewMode,
    setViewMode,
    sidebarOpen,
    setSidebarOpen,

    // Upload modal
    uploadModalOpen,
    setUploadModalOpen,
    uploadModalProcessing,
    setUploadModalProcessing,
    uploadModalProcessingRequestId,
    setUploadModalProcessingRequestId,
    uploadScanCount,
    setUploadScanCount,
    uploadModalInitialEntries,
    openUploadModalWithEntries: (entries: UploadModalInitialEntry[]) => {
      setUploadModalInitialEntries(entries);
      setUploadModalOpen(true);
    },
    clearUploadModalInitialEntries: () => setUploadModalInitialEntries(null),

    // Other modals
    createFolderModalOpen,
    setCreateFolderModalOpen,
    imageViewerFile,
    setImageViewerFile,
    documentViewerFile,
    setDocumentViewerFile,
    shareLinkModalOpen,
    shareLinks,
    setShareLinkModalOpen: (open: boolean, links: string[] = []) => {
      setShareLinks(open ? links : []);
      setShareLinkModalOpenState(open);
    },
    renameTarget,
    setRenameTarget,
  };
}
