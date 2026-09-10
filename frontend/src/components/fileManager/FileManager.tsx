import React, { useState, useCallback, useRef } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useApp, type FileItem, type FileSortBy, type ShareExpiry } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { Breadcrumbs } from './Breadcrumbs';
import { Tooltip } from '../ui/Tooltip';
import { ContextMenu } from './ContextMenu';
import { PasteProgress } from './PasteProgress';
import { DesktopOpenProgress } from './DesktopOpenProgress';
import { DeleteProgress } from './DeleteProgress';
import { RestoreProgress } from './RestoreProgress';
import { ONLYOFFICE_EXTS, getExt, validateOnlyOfficeMimeType } from '../../utils/fileUtils';
import { isElectron } from '../../utils/electronDesktop';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useToast } from '../../hooks/useToast';
import { getErrorMessage } from '../../utils/errorUtils';
import { EmptyTrashModal, DeleteModal, DeleteForeverModal } from './FileManagerModals';
import { FileManagerToolbar } from './FileManagerToolbar';
import { FileList } from './FileList';
import { MultiSelectIndicator } from './MultiSelectIndicator';
import { ShareExpiryModal } from './ShareLinkModal';
import { FileInfoModal } from './FileInfoModal';
import { useFileSelection } from './hooks/useFileSelection';
import { useFileDragAndDrop } from './hooks/useFileDragAndDrop';
import { useExternalFileDrop } from './hooks/useExternalFileDrop';
import { useFileManagerShortcuts } from './hooks/useFileManagerShortcuts';

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
    linkToParentShare,
    folderSharedStack,
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
    setUploadScanCount,
    clearUploadModalInitialEntries,
    desktopOpenProgress,
  } = useApp();

  // Sub-users only see actions they were granted; the rest are omitted.
  const { can } = useAuth();
  const { showToast } = useToast();
  const isMobile = useIsMobile();

  const [emptyTrashModalOpen, setEmptyTrashModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteForeverModalOpen, setDeleteForeverModalOpen] = useState(false);
  const [shareExpiryModalOpen, setShareExpiryModalOpen] = useState(false);
  // Keep the selection that opened the modal. The live selection can change
  // while the modal is open (for example after a click-outside handler runs).
  const [pendingShareFiles, setPendingShareFiles] = useState<string[]>([]);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoModalFile, setInfoModalFile] = useState<FileItem | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    targetId: string | null;
  }>({ isOpen: false, position: { x: 0, y: 0 }, targetId: null });

  const managerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  /** Set while a marquee drag is active; shared between selection and drag hooks. */
  const dragSelectingRef = useRef(false);

  // Folder creation, upload and drop all need the upload grant.
  const canUpload = can('files.upload');
  const canCreateFolder = currentPath[0] === 'My Files' && canUpload;
  const isTrashView = currentPath[0] === 'Trash';
  const hasTrashFiles = isTrashView && files.length > 0;
  const isMyFilesView = currentPath[0] === 'My Files';

  const openInfoModalForSelection = useCallback(() => {
    if (isTrashView) return;
    if (!selectedFiles.length) return;

    const selectedItems = files.filter(f => selectedFiles.includes(f.id));
    const singleSelectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
    if (!singleSelectedItem) return;

    setInfoModalFile(singleSelectedItem);
    setInfoModalOpen(true);
  }, [files, isTrashView, selectedFiles]);

  // Selection state machine (single/ctrl/shift/marquee, mobile multi-select,
  // click-outside-to-clear, scroll-return-after-navigate-up).
  const {
    isSelecting,
    multiSelectMode,
    setMultiSelectMode,
    closeMultiSelectIfMobile,
    handleClearSelection,
    handleSelectingChange,
    handleFileClick,
    handleMarqueeSelection,
    listScrollRequest,
    clearListScrollRequest,
  } = useFileSelection({
    files,
    selectedFiles,
    setSelectedFiles,
    addSelectedFile,
    removeSelectedFile,
    clearSelection,
    isMobile,
    folderStack,
    managerRef,
    dragSelectingRef,
  });

  // Internal move drag-and-drop (drag items onto a folder).
  const {
    draggingIds,
    dragOverFolder,
    handleDragStart,
    handleDragEnd,
    handleFolderDragOver,
    handleFolderDragLeave,
    handleFolderDrop,
  } = useFileDragAndDrop({
    selectedFiles,
    setSelectedFiles,
    isMobile,
    dragSelectingRef,
    can,
    moveFiles,
    closeMultiSelectIfMobile,
    showToast,
  });

  // External OS drop → upload modal.
  const { isExternalDragOver, handleExternalDragOver, handleExternalDragLeave, handleExternalDrop } =
    useExternalFileDrop({
      draggingIds,
      isMyFilesView,
      canUpload,
      managerRef,
      uploadModalProcessing,
      uploadModalProcessingRequestId,
      setUploadModalOpen,
      setUploadModalProcessing,
      setUploadModalProcessingRequestId,
      setUploadScanCount,
      clearUploadModalInitialEntries,
      openUploadModalWithEntries,
      showToast,
    });

  // Global keyboard/mouse/paste shortcuts.
  useFileManagerShortcuts({
    files,
    selectedFiles,
    folderStack,
    isMyFilesView,
    isTrashView,
    canUpload,
    isDeleting,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    uploadFile,
    uploadFilesBulk,
    clipboardCopy,
    clipboardPaste,
    setClipboard,
    setSelectedFiles,
    openInfoModalForSelection,
    setDeleteModalOpen,
    showToast,
  });

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

  const handleFileDoubleClick = (file: FileItem) => {
    // Don't allow opening anything from Trash
    if (currentPath[0] === 'Trash') {
      return;
    }

    if (file.type === 'folder') {
      openFolder(file);
    } else {
      const mime = (file.mimeType || '').toLowerCase();

      // In Electron, open image/video/audio in the system default app.
      if (isElectron() && (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/'))) {
        void editFileWithDesktop(file.id);
      } else if (mime.startsWith('image/')) {
        setImageViewerFile(file);
      } else if (isElectron() && ONLYOFFICE_EXTS.has(getExt(file.name))) {
        // In Electron, open Office docs in the native app rather than ONLYOFFICE.
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

  // Calculate shared/starred status for selected files
  const selectedItems = files.filter(f => selectedFiles.includes(f.id));
  const allShared = selectedItems.length > 0 && selectedItems.every(f => f.shared);
  const allUnshared = selectedItems.length > 0 && selectedItems.every(f => !f.shared);
  const allStarred = selectedItems.length > 0 && selectedItems.every(f => f.starred);
  // Inside a shared folder, unshared items join that folder's share rather than
  // minting a new link, so the share action becomes "Link to Folder Share".
  const parentShared = !!folderSharedStack[folderSharedStack.length - 1];
  const canLinkToParentShare = parentShared && allUnshared;

  const handleShare = () => {
    if (allShared) {
      // Unsharing — no expiry picker needed
      shareFiles(selectedFiles, false)
        .then(() => closeMultiSelectIfMobile())
        .catch(() => closeMultiSelectIfMobile());
    } else {
      // Sharing — show expiry picker first
      setPendingShareFiles([...selectedFiles]);
      setShareExpiryModalOpen(true);
    }
  };

  const handleLinkToParentShare = async () => {
    try {
      await linkToParentShare(selectedFiles);
      showToast('Linked to folder share', 'success');
      closeMultiSelectIfMobile();
    } catch {
      showToast('Failed to link to folder share', 'error');
      closeMultiSelectIfMobile();
    }
  };

  const handleShareConfirm = async (expiry: ShareExpiry) => {
    setShareExpiryModalOpen(false);
    const ids = pendingShareFiles;
    setPendingShareFiles([]);
    if (ids.length === 0) return;
    try {
      const links = await shareFiles(ids, true, expiry);
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
          canLinkToParentShare={canLinkToParentShare}
          onLinkToParentShare={handleLinkToParentShare}
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
            // downloadFiles surfaces its own failures (cards + toast) and never throws.
            await downloadFiles(selectedFiles);
            closeMultiSelectIfMobile();
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
        onClose={() => {
          setShareExpiryModalOpen(false);
          setPendingShareFiles([]);
        }}
        onConfirm={handleShareConfirm}
        fileCount={pendingShareFiles.length}
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
