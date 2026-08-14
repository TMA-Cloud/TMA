import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useApp, type FileItem, type FileSortBy, type ShareExpiry } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { Breadcrumbs } from './Breadcrumbs';
import { Tooltip } from '../ui/Tooltip';
import { ContextMenu } from './ContextMenu';
import { PasteProgress } from './PasteProgress';
import { DownloadProgress } from './DownloadProgress';
import { DesktopOpenProgress } from './DesktopOpenProgress';
import { DeleteProgress } from './DeleteProgress';
import { RestoreProgress } from './RestoreProgress';
import { ONLYOFFICE_EXTS, getExt, validateOnlyOfficeMimeType } from '../../utils/fileUtils';
import { isElectron } from '../../utils/electronDesktop';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useToast } from '../../hooks/useToast';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  createDragPreview,
  moveDragPreview,
  removeDragPreview,
  animateFlyToFolder,
  getTransparentImage,
} from './utils/dragPreview';
import { EmptyTrashModal, DeleteModal, DeleteForeverModal } from './FileManagerModals';
import { FileManagerToolbar } from './FileManagerToolbar';
import { FileList } from './FileList';
import { MultiSelectIndicator } from './MultiSelectIndicator';
import { ShareExpiryModal } from './ShareLinkModal';
import { FileInfoModal } from './FileInfoModal';
import { entriesFromDataTransfer } from '../../utils/folderUpload';

export const FileManager: React.FC = () => {
  const {
    files,
    selectedFiles,
    viewMode,
    currentPath,
    folderStack,
    setClipboard,
    clipboardCopy,
    clipboardPaste,
    setViewMode,
    setSelectedFiles,
    addSelectedFile,
    removeSelectedFile,
    clearSelection,
    openFolder,
    setCreateFolderModalOpen,
    moveFiles,
    setImageViewerFile,
    pasteProgress,
    sortBy,
    sortOrder,
    setSortBy,
    setSortOrder,
    setDocumentViewerFile,
    searchQuery,
    isSearching,
    isDownloading,
    isDeleting,
    isRestoring,
    deleteProgress,
    restoreProgress,
    emptyTrash,
    shareFiles,
    starFiles,
    downloadFiles,
    setRenameTarget,
    deleteFiles,
    restoreFiles,
    deleteForever,
    setShareLinkModalOpen,
    onlyOfficeConfigured,
    canConfigureOnlyOffice,
    uploadFile,
    uploadFilesBulk,
    editFileWithDesktop,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    openUploadModalWithEntries,
    setUploadModalOpen,
    uploadModalProcessing,
    setUploadModalProcessing,
    uploadModalProcessingRequestId,
    setUploadModalProcessingRequestId,
    clearUploadModalInitialEntries,
    desktopOpenProgress,
  } = useApp();

  // Sub-users only see the actions they were granted; the rest are omitted
  // rather than shown and rejected by the server.
  const { can } = useAuth();
  const { showToast } = useToast();
  const [emptyTrashModalOpen, setEmptyTrashModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteForeverModalOpen, setDeleteForeverModalOpen] = useState(false);
  const [shareExpiryModalOpen, setShareExpiryModalOpen] = useState(false);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoModalFile, setInfoModalFile] = useState<FileItem | null>(null);
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);

  const activeUploadProcessingRequestIdRef = React.useRef<string | null>(uploadModalProcessingRequestId);
  const uploadModalProcessingRef = React.useRef(uploadModalProcessing);
  useEffect(() => {
    activeUploadProcessingRequestIdRef.current = uploadModalProcessingRequestId;
  }, [uploadModalProcessingRequestId]);
  useEffect(() => {
    uploadModalProcessingRef.current = uploadModalProcessing;
  }, [uploadModalProcessing]);

  // Creating folders, uploading and dropping files all need the upload
  // grant; without it the drop zone and its affordances stay hidden.
  const canUpload = can('files.upload');
  const canCreateFolder = currentPath[0] === 'My Files' && canUpload;
  const isTrashView = currentPath[0] === 'Trash';
  const hasTrashFiles = isTrashView && files.length > 0;
  const isMyFilesView = currentPath[0] === 'My Files';

  // Paste (Ctrl+V): upload clipboard files only in My Files
  useEffect(() => {
    if (!isMyFilesView || !canUpload) return;

    const onPaste = (e: ClipboardEvent) => {
      const fileList = e.clipboardData?.files;
      if (!fileList || fileList.length === 0) return;

      const target = e.target as Node;
      if (
        target &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable))
      ) {
        return; // let input handle paste
      }

      e.preventDefault();
      const pastedFiles = Array.from(fileList);
      if (pastedFiles.length === 1) {
        const file = pastedFiles[0];
        if (file) void uploadFile(file);
      } else if (pastedFiles.length > 1) {
        void uploadFilesBulk(pastedFiles);
      }
    };

    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [isMyFilesView, canUpload, uploadFile, uploadFilesBulk]);

  // Mouse back/forward (e.g. G502 X side buttons): button 3 = back, button 4 = forward
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      const target = e.target as HTMLElement;
      if (target?.closest('input, textarea, select, [contenteditable="true"]') || target?.closest('[role="dialog"]')) {
        return;
      }
      if (e.button === 3 && canGoBack) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      } else if (e.button === 4 && canGoForward) {
        e.preventDefault();
        e.stopPropagation();
        goForward();
      }
    };
    window.addEventListener('mouseup', onMouseUp, { capture: true });
    return () => window.removeEventListener('mouseup', onMouseUp, { capture: true });
  }, [canGoBack, canGoForward, goBack, goForward]);

  const openInfoModalForSelection = useCallback(() => {
    if (isTrashView) return;
    if (!selectedFiles.length) return;

    const selectedItems = files.filter(f => selectedFiles.includes(f.id));
    const singleSelectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
    if (!singleSelectedItem) return;

    setInfoModalFile(singleSelectedItem);
    setInfoModalOpen(true);
  }, [files, isTrashView, selectedFiles]);

  // Electron desktop: unified clipboard shortcuts.
  // - Ctrl+C: copy (cloud + OS clipboard for files that fit)
  // - Ctrl+X: cut (cloud only)
  // - Ctrl+V: smart paste — cloud clipboard if set, otherwise upload from OS clipboard
  // - Ctrl+Shift+I: Get Info for selected item
  // - Ctrl+A: select all
  useEffect(() => {
    if (!isElectron()) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      const target = e.target as Node | null;
      if (
        target &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable))
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      if (key === 'a') {
        e.preventDefault();
        if (!files.length) return;
        const allIds = files.map(f => f.id);
        setSelectedFiles(allIds);
        return;
      }

      if (key === 'c') {
        if (!selectedFiles.length) return;
        e.preventDefault();
        clipboardCopy(selectedFiles);
        return;
      }

      if (key === 'x') {
        if (!selectedFiles.length) return;
        e.preventDefault();
        setClipboard({ ids: selectedFiles, action: 'cut' });
        showToast(
          `Cut ${selectedFiles.length} item${selectedFiles.length !== 1 ? 's' : ''} — paste to move`,
          'success'
        );
        return;
      }

      if (key === 'v') {
        e.preventDefault();
        void clipboardPaste(folderStack[folderStack.length - 1] ?? null).catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          showToast(message || 'Failed to paste files', 'error');
        });
      }

      if (key === 'i' && e.shiftKey) {
        if (!selectedFiles.length) return;
        e.preventDefault();
        void openInfoModalForSelection();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    clipboardCopy,
    clipboardPaste,
    files,
    folderStack,
    openInfoModalForSelection,
    selectedFiles,
    setClipboard,
    setSelectedFiles,
    showToast,
  ]);

  const handleEmptyTrash = async () => {
    setEmptyTrashModalOpen(false);
    try {
      const result = await emptyTrash();
      handleClearSelection(); // Clear selection after successful deletion
      showToast(
        result?.message || `Trash emptied — ${files.length} item${files.length !== 1 ? 's' : ''} deleted`,
        'success'
      );
    } catch (error: unknown) {
      showToast(getErrorMessage(error, 'Failed to empty trash'), 'error');
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;
    setDeleteModalOpen(false);
    try {
      await deleteFiles(selectedFiles);
      const count = selectedFiles.length;
      handleClearSelection(); // Clear selection after successful deletion
      showToast(`Moved ${count} item${count !== 1 ? 's' : ''} to trash`, 'success');
    } catch (error: unknown) {
      showToast(getErrorMessage(error, 'Failed to move items to trash'), 'error');
    }
  };

  const handleDeleteForever = async () => {
    if (isDeleting) return;
    setDeleteForeverModalOpen(false);
    try {
      await deleteForever(selectedFiles);
      const count = selectedFiles.length;
      handleClearSelection(); // Clear selection after successful deletion
      showToast(`Permanently deleted ${count} item${count !== 1 ? 's' : ''}`, 'success');
    } catch (error: unknown) {
      showToast(getErrorMessage(error, 'Failed to delete permanently'), 'error');
    }
  };

  const handleRestore = async () => {
    if (isRestoring) return;
    try {
      const result = await restoreFiles(selectedFiles);
      const count = selectedFiles.length;
      handleClearSelection(); // Clear selection after successful restore
      showToast(result?.message || `Restored ${count} item${count !== 1 ? 's' : ''} from trash`, 'success');
    } catch (error: unknown) {
      showToast(getErrorMessage(error, 'Failed to restore items'), 'error');
    }
  };

  const dragSelectingRef = useRef(false);
  const managerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);

  // Clean up is-dragging class on unmount or when drag ends unexpectedly
  useEffect(() => {
    if (draggingIds.length === 0) {
      document.body.classList.remove('is-dragging');
    }
    return () => {
      document.body.classList.remove('is-dragging');
    };
  }, [draggingIds]);
  const multiSelectModeRef = useRef(multiSelectMode);

  // Keep ref in sync with state
  useEffect(() => {
    multiSelectModeRef.current = multiSelectMode;
  }, [multiSelectMode]);

  // track marquee‐drag state in a ref only (we never read dragSelecting)
  const handleSelectingChange = useCallback((selecting: boolean) => {
    dragSelectingRef.current = selecting;
    setIsSelecting(selecting);
  }, []);

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    targetId: string | null;
  }>({ isOpen: false, position: { x: 0, y: 0 }, targetId: null });

  const isMobile = useIsMobile();

  // Helper to close multi-select mode on mobile
  const closeMultiSelectIfMobile = useCallback(() => {
    if (isMobile && multiSelectModeRef.current) {
      setMultiSelectMode(false);
    }
  }, [isMobile, setMultiSelectMode]);

  // Wrapper for clearSelection that also exits multi-select mode on mobile
  const handleClearSelection = useCallback(() => {
    clearSelection();
    closeMultiSelectIfMobile();
  }, [clearSelection, closeMultiSelectIfMobile]);

  // Wrapper for removeSelectedFile that exits multi-select mode when last file is deselected
  const handleRemoveSelectedFile = useCallback(
    (fileId: string) => {
      removeSelectedFile(fileId);
      if (isMobile && multiSelectMode && selectedFiles.length === 1) {
        // If this was the last selected file, exit multi-select mode
        setMultiSelectMode(false);
      }
    },
    [removeSelectedFile, isMobile, multiSelectMode, selectedFiles.length, setMultiSelectMode]
  );

  // Filter out deleted files from selection
  useEffect(() => {
    const validSelectedFiles = selectedFiles.filter(id => files.some(f => f.id === id));
    if (validSelectedFiles.length !== selectedFiles.length) {
      setSelectedFiles(validSelectedFiles);
    }
  }, [files, selectedFiles, setSelectedFiles]);

  const prevFolderStackLenRef = useRef(folderStack.length);
  /** True after navigating up; cleared after we scroll to the restored selection (applied async after fetch) */
  const scrollReturnHighlightRef = useRef(false);

  useEffect(() => {
    const prevLen = prevFolderStackLenRef.current;
    const len = folderStack.length;
    if (len < prevLen) scrollReturnHighlightRef.current = true;
    if (len > prevLen) scrollReturnHighlightRef.current = false;
    prevFolderStackLenRef.current = len;
  }, [folderStack.length]);

  const [listScrollRequest, setListScrollRequest] = useState<{ fileId: string; token: number } | null>(null);
  const listScrollTokenRef = useRef(0);
  const clearListScrollRequest = useCallback(() => setListScrollRequest(null), []);

  useEffect(() => {
    if (!scrollReturnHighlightRef.current) return;
    if (selectedFiles.length > 1) {
      scrollReturnHighlightRef.current = false;
      return;
    }
    if (selectedFiles.length !== 1) return;
    const id = selectedFiles[0];
    if (!id || !files.some(f => f.id === id)) return;

    scrollReturnHighlightRef.current = false;
    listScrollTokenRef.current += 1;
    setListScrollRequest({ fileId: id, token: listScrollTokenRef.current });
  }, [files, selectedFiles]);

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (dragSelectingRef.current) return;

      const manager = managerRef.current;
      if (manager && !manager.contains(e.target as Node)) {
        handleClearSelection();
      }
    };

    document.addEventListener('click', handleDocumentClick);

    const handleDrag = (ev: DragEvent) => {
      if (!isMobile) {
        moveDragPreview(ev.clientX, ev.clientY);
      }
    };
    document.addEventListener('dragover', handleDrag);

    return () => {
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('dragover', handleDrag);
    };
  }, [handleClearSelection, isMobile]);

  // Keyboard Delete: move selected files/folders to trash
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;

      const target = e.target as Node | null;
      if (
        target &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable))
      ) {
        return;
      }

      if (!selectedFiles.length) return;
      if (isTrashView) return;
      if (isDeleting) return;

      e.preventDefault();
      setDeleteModalOpen(true);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isTrashView, isDeleting, selectedFiles.length, setDeleteModalOpen]);

  const handleFileClick = (fileId: string, e: React.MouseEvent) => {
    if (dragSelectingRef.current) return;

    e.preventDefault();
    e.stopPropagation(); // ← prevent the container's onClick from firing

    // Mobile multi-select mode
    if (isMobile && multiSelectMode) {
      if (selectedFiles.includes(fileId)) {
        handleRemoveSelectedFile(fileId);
      } else {
        addSelectedFile(fileId);
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      // Multi-select with Ctrl/Cmd
      if (selectedFiles.includes(fileId)) {
        handleRemoveSelectedFile(fileId);
      } else {
        addSelectedFile(fileId);
      }
    } else if (e.shiftKey && selectedFiles.length > 0) {
      // Range select with Shift
      const fileIds = files.map(f => f.id);
      const lastSelectedId = selectedFiles[selectedFiles.length - 1];
      if (!lastSelectedId) return; // Safety check
      const lastSelectedIndex = fileIds.indexOf(lastSelectedId);
      const clickedIndex = fileIds.indexOf(fileId);

      const start = Math.min(lastSelectedIndex, clickedIndex);
      const end = Math.max(lastSelectedIndex, clickedIndex);
      const rangeIds = fileIds.slice(start, end + 1);

      setSelectedFiles([...new Set([...selectedFiles, ...rangeIds])]);
    } else {
      // Single select
      setSelectedFiles([fileId]);
    }
  };

  const handleFileDoubleClick = (file: FileItem) => {
    // Don't allow opening anything from Trash
    if (currentPath[0] === 'Trash') {
      return;
    }

    if (file.type === 'folder') {
      openFolder(file);
    } else {
      const mime = (file.mimeType || '').toLowerCase();

      // In the Electron desktop app, open images, videos, and audio directly
      // in the system default application.
      if (isElectron() && (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/'))) {
        void editFileWithDesktop(file.id);
      } else if (mime.startsWith('image/')) {
        setImageViewerFile(file);
      } else if (isElectron() && ONLYOFFICE_EXTS.has(getExt(file.name))) {
        // In the Electron desktop app, open Office documents directly
        // in the native desktop application (Word/Excel/PowerPoint, etc.)
        // instead of routing through ONLYOFFICE in the browser.
        void editFileWithDesktop(file.id);
      } else if (ONLYOFFICE_EXTS.has(getExt(file.name))) {
        // Validate MIME type before opening (prevents unnecessary API calls)
        if (!validateOnlyOfficeMimeType(file.name, file.mimeType)) {
          const ext = getExt(file.name);
          showToast(`Can't open — this isn't a valid .${ext.slice(1)} file`, 'error');
          return;
        }
        // Check if OnlyOffice is configured before opening (using cached value)
        if (!onlyOfficeConfigured) {
          if (isElectron()) {
            void editFileWithDesktop(file.id);
          } else {
            if (canConfigureOnlyOffice) {
              showToast("OnlyOffice isn't set up — configure it in Settings", 'error');
            } else {
              showToast("OnlyOffice isn't set up — ask your administrator", 'error');
            }
          }
          return;
        }
        // On mobile, open in new tab instead of modal
        if (isMobile) {
          const url = `/api/onlyoffice/viewer/${file.id}`;
          window.open(url, '_blank', 'noopener,noreferrer');
        } else {
          setDocumentViewerFile?.(file);
        }
      }
    }
    closeMultiSelectIfMobile();
  };

  const handleContextMenu = (e: React.MouseEvent, fileId?: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (fileId && !selectedFiles.includes(fileId)) {
      setSelectedFiles([fileId]);
    }

    setContextMenu({
      isOpen: true,
      position: { x: e.clientX, y: e.clientY },
      targetId: fileId ?? null,
    });
  };

  const handleMarqueeSelection = useCallback(
    (selectedIds: string[], additive: boolean) => {
      if (additive) {
        // merge current selection + new marquee hits
        const merged = Array.from(new Set([...selectedFiles, ...selectedIds]));
        setSelectedFiles(merged);
      } else {
        setSelectedFiles(selectedIds);
      }
    },
    [selectedFiles, setSelectedFiles]
  );

  const handleDragStart = (fileId: string) => (e: React.DragEvent) => {
    if (dragSelectingRef.current || isMobile) {
      e.preventDefault();
      return;
    }
    if (!selectedFiles.includes(fileId)) {
      setSelectedFiles([fileId]);
      setDraggingIds([fileId]);
    } else {
      setDraggingIds(selectedFiles);
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(getTransparentImage(), 0, 0);
    // mark global dragging state (used to suppress tooltips)
    document.body.classList.add('is-dragging');
    createDragPreview(selectedFiles.includes(fileId) ? selectedFiles : [fileId], e.clientX, e.clientY, isMobile);
  };

  const handleDragEnd = () => {
    setDraggingIds([]);
    setDragOverFolder(null);
    removeDragPreview();
    document.body.classList.remove('is-dragging');
  };

  const handleFolderDragOver = (folderId: string) => (e: React.DragEvent) => {
    if (dragSelectingRef.current || draggingIds.length === 0) return;
    if (folderId && draggingIds.includes(folderId)) return;
    e.preventDefault();
    if (dragOverFolder !== folderId) setDragOverFolder(folderId);
  };

  const handleFolderDragLeave = (folderId: string) => () => {
    if (dragOverFolder === folderId) setDragOverFolder(null);
  };

  const handleFolderDrop = (folderId: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    // Dropping onto a folder is a move, so it needs the modify grant.
    if (dragSelectingRef.current || draggingIds.length === 0 || !can('files.edit')) return;
    setDragOverFolder(null);
    removeDragPreview();
    try {
      await animateFlyToFolder(draggingIds, folderId);
      await moveFiles(draggingIds, folderId);
      setDraggingIds([]);
      document.body.classList.remove('is-dragging');
      closeMultiSelectIfMobile();
    } catch (error) {
      // Show error toast if not already shown by moveFiles
      const errorMessage = getErrorMessage(error, 'Failed to move files. Please try again.');
      showToast(errorMessage, 'error');
      // Reset drag state on error
      setDraggingIds([]);
      document.body.classList.remove('is-dragging');
      closeMultiSelectIfMobile();
    }
  };

  // Calculate shared/starred status for selected files
  const selectedItems = files.filter(f => selectedFiles.includes(f.id));
  const allShared = selectedItems.length > 0 && selectedItems.every(f => f.shared);
  const allStarred = selectedItems.length > 0 && selectedItems.every(f => f.starred);

  const handleShare = () => {
    if (allShared) {
      // Unsharing — no expiry picker needed
      shareFiles(selectedFiles, false)
        .then(() => closeMultiSelectIfMobile())
        .catch(() => closeMultiSelectIfMobile());
    } else {
      // Sharing — show expiry picker first
      setShareExpiryModalOpen(true);
    }
  };

  const handleShareConfirm = async (expiry: ShareExpiry) => {
    setShareExpiryModalOpen(false);
    try {
      const links = await shareFiles(selectedFiles, true, expiry);
      const list = Object.values(links);
      setShareLinkModalOpen(true, list);
      closeMultiSelectIfMobile();
    } catch {
      closeMultiSelectIfMobile();
    }
  };

  const handleStar = async () => {
    try {
      await starFiles(selectedFiles, !allStarred);
      closeMultiSelectIfMobile();
    } catch {
      // Error already handled by starFilesApi (toast shown)
      // Just prevent uncaught promise error
      closeMultiSelectIfMobile();
    }
  };

  const handleRename = () => {
    if (selectedFiles.length === 1) {
      const file = files.find(f => f.id === selectedFiles[0]);
      if (file) setRenameTarget(file);
      closeMultiSelectIfMobile();
    }
  };

  // Drag-and-drop from OS: open upload modal with dropped files/folders (My Files only)
  const handleExternalDragOver = useCallback(
    (e: React.DragEvent) => {
      if (draggingIds.length > 0) return;
      if (!isMyFilesView) return;
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsExternalDragOver(true);
    },
    [draggingIds.length, isMyFilesView]
  );

  const handleExternalDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (!related || !managerRef.current?.contains(related)) {
      setIsExternalDragOver(false);
    }
  }, []);

  const handleExternalDrop = useCallback(
    async (e: React.DragEvent) => {
      if (draggingIds.length > 0) return;
      if (!canUpload) return;
      if (!e.dataTransfer.files?.length) return;
      if (uploadModalProcessingRef.current) return; // Prevent duplicate drops while we are still scanning folders.
      e.preventDefault();
      e.stopPropagation();
      setIsExternalDragOver(false);
      if (!isMyFilesView) return;
      const requestId = `${Date.now()}-${Math.random()}`;
      try {
        // Open the modal immediately so users get feedback for large folder scans.
        setUploadModalOpen(true);
        setUploadModalProcessing(true);
        setUploadModalProcessingRequestId(requestId);
        clearUploadModalInitialEntries();

        const entries = await entriesFromDataTransfer(e.dataTransfer);
        // User might have closed the modal while we were scanning.
        if (activeUploadProcessingRequestIdRef.current !== requestId) return;

        if (entries.length > 0) {
          openUploadModalWithEntries(entries.map(en => ({ file: en.file, relativePath: en.relativePath })));
          // We keep the modal in "processing" state until the modal consumes the initial entries.
        } else {
          setUploadModalProcessing(false);
          setUploadModalOpen(false);
          showToast('Nothing to upload in that drop', 'info');
        }
      } catch {
        if (activeUploadProcessingRequestIdRef.current !== requestId) return;
        // entriesFromDataTransfer can throw; reset state and close modal (matches previous behavior).
        setUploadModalProcessing(false);
        setUploadModalOpen(false);
        showToast('Failed to read that folder', 'error');
      }
    },
    [
      draggingIds.length,
      isMyFilesView,
      canUpload,
      openUploadModalWithEntries,
      setUploadModalOpen,
      setUploadModalProcessing,
      setUploadModalProcessingRequestId,
      clearUploadModalInitialEntries,
      showToast,
    ]
  );

  return (
    <div
      className={`
        ${isMobile ? 'p-3' : 'p-6 md:p-8'} relative flex flex-col space-y-6 md:space-y-8
        ${isMyFilesView ? 'min-h-[calc(100vh-16rem)] pb-28' : ''}
        ${isExternalDragOver ? 'ring-2 ring-blue-400 ring-inset rounded-xl' : ''}
      `}
      ref={managerRef}
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
    >
      {/* Multi-Select Mode Indicator (Mobile Only) */}
      {isMobile && multiSelectMode && (
        <MultiSelectIndicator
          selectedCount={selectedFiles.length}
          onExit={() => {
            setMultiSelectMode(false);
            handleClearSelection();
          }}
        />
      )}

      {/* Header */}
      <div
        ref={headerRef}
        className={`${isMobile ? 'flex-col space-y-3 px-3 py-3' : 'flex items-center justify-between px-6 py-4'} rounded-xl card-premium mb-4 transition-all duration-200 animate-slideDown sticky top-0 z-30`}
      >
        <div className={`${isMobile ? 'w-full' : 'flex-1 min-w-0'} flex items-center gap-3`}>
          {isElectron() && (
            <div className="flex items-center flex-shrink-0 rounded-xl bg-[var(--fill-quaternary)] p-1 ring-1 ring-[var(--separator)]">
              <Tooltip text="Back">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={!canGoBack}
                  className="p-2.5 rounded-lg text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200/80 dark:hover:bg-gray-600/60 disabled:opacity-40 disabled:pointer-events-none transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                  aria-label="Back"
                >
                  <ArrowLeft className="w-6 h-6" strokeWidth={2.25} />
                </button>
              </Tooltip>
              <Tooltip text="Forward">
                <button
                  type="button"
                  onClick={goForward}
                  disabled={!canGoForward}
                  className="p-2.5 rounded-lg text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200/80 dark:hover:bg-gray-600/60 disabled:opacity-40 disabled:pointer-events-none transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                  aria-label="Forward"
                >
                  <ArrowRight className="w-6 h-6" strokeWidth={2.25} />
                </button>
              </Tooltip>
            </div>
          )}
          <div className={`${isMobile ? 'flex-1 min-w-0' : 'min-w-0'} flex-1`}>
            <Breadcrumbs />
          </div>
        </div>

        <FileManagerToolbar
          isMobile={isMobile}
          viewMode={viewMode}
          sortBy={sortBy}
          sortOrder={sortOrder}
          selectedFiles={selectedFiles}
          isTrashView={isTrashView}
          hasTrashFiles={hasTrashFiles}
          canCreateFolder={canCreateFolder}
          allShared={allShared}
          allStarred={allStarred}
          isDownloading={isDownloading}
          isDeleting={isDeleting}
          isRestoring={isRestoring}
          onViewModeChange={setViewMode}
          onSortChange={(by, order) => {
            setSortBy(by as FileSortBy);
            setSortOrder(order);
          }}
          onCreateFolder={() => setCreateFolderModalOpen(true)}
          onShare={handleShare}
          onStar={handleStar}
          onDownload={async () => {
            try {
              await downloadFiles(selectedFiles);
              closeMultiSelectIfMobile();
            } catch {
              // Error already handled by downloadFiles (toast shown)
              // Just prevent uncaught promise error
              closeMultiSelectIfMobile();
            }
          }}
          onRename={handleRename}
          onDelete={() => {
            if (isDeleting) return;
            setDeleteModalOpen(true);
          }}
          onRestore={handleRestore}
          onDeleteForever={() => {
            if (isDeleting) return;
            setDeleteForeverModalOpen(true);
          }}
          onEmptyTrash={() => setEmptyTrashModalOpen(true)}
        />
      </div>

      {/* File List */}
      <FileList
        files={files}
        selectedFiles={selectedFiles}
        viewMode={viewMode}
        isMobile={isMobile}
        isSearching={isSearching}
        searchQuery={searchQuery}
        currentPath={currentPath}
        canCreateFolder={canCreateFolder}
        dragOverFolder={dragOverFolder}
        draggingIds={draggingIds}
        isSelecting={isSelecting}
        dragSelectingRef={dragSelectingRef}
        onFileClick={handleFileClick}
        onFileDoubleClick={handleFileDoubleClick}
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onFolderDragOver={handleFolderDragOver}
        onFolderDragLeave={handleFolderDragLeave}
        onFolderDrop={handleFolderDrop}
        onClearSelection={handleClearSelection}
        onMarqueeSelection={handleMarqueeSelection}
        onSelectingChange={handleSelectingChange}
        listScrollRequest={listScrollRequest}
        onListScrollRequestHandled={clearListScrollRequest}
      />

      {/* Context Menu */}
      <ContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        onClose={() =>
          setContextMenu({
            isOpen: false,
            position: { x: 0, y: 0 },
            targetId: null,
          })
        }
        targetId={contextMenu.targetId}
        selectedCount={selectedFiles.length}
        multiSelectMode={multiSelectMode}
        setMultiSelectMode={setMultiSelectMode}
        onActionComplete={closeMultiSelectIfMobile}
      />

      <PasteProgress progress={pasteProgress} />
      {desktopOpenProgress.length > 0 && <DesktopOpenProgress items={desktopOpenProgress} />}
      <DeleteProgress progress={deleteProgress} />
      <RestoreProgress progress={restoreProgress} />
      <DownloadProgress
        isDownloading={isDownloading}
        hasFolders={selectedFiles.some(id => files.find(f => f.id === id)?.type === 'folder')}
      />

      <EmptyTrashModal
        isOpen={emptyTrashModalOpen}
        onClose={() => setEmptyTrashModalOpen(false)}
        onConfirm={handleEmptyTrash}
        fileCount={files.length}
      />

      <DeleteModal
        isOpen={deleteModalOpen}
        onClose={() => {
          if (isDeleting) return;
          setDeleteModalOpen(false);
        }}
        onConfirm={handleDelete}
        fileCount={selectedFiles.length}
        isLoading={isDeleting}
      />

      <DeleteForeverModal
        isOpen={deleteForeverModalOpen}
        onClose={() => {
          if (isDeleting) return;
          setDeleteForeverModalOpen(false);
        }}
        onConfirm={handleDeleteForever}
        fileCount={selectedFiles.length}
        isLoading={isDeleting}
      />

      <ShareExpiryModal
        isOpen={shareExpiryModalOpen}
        onClose={() => setShareExpiryModalOpen(false)}
        onConfirm={handleShareConfirm}
        fileCount={selectedFiles.length}
      />
      <FileInfoModal
        isOpen={infoModalOpen}
        onClose={() => setInfoModalOpen(false)}
        file={infoModalFile}
        currentPath={currentPath}
      />
    </div>
  );
};

export default FileManager;
