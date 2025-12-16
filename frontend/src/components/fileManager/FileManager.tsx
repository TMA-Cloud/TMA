import React, { useState, useCallback, useRef, useEffect } from "react";
import { useApp, type FileItem } from "../../contexts/AppContext";
import { Breadcrumbs } from "./Breadcrumbs";
import { ContextMenu } from "./ContextMenu";
import { PasteProgress } from "./PasteProgress";
import { DownloadProgress } from "./DownloadProgress";
import { ONLYOFFICE_EXTS, getExt } from "../../utils/fileUtils";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useToast } from "../../hooks/useToast";
import {
  createDragPreview,
  moveDragPreview,
  removeDragPreview,
  animateFlyToFolder,
  getTransparentImage,
} from "./utils/dragPreview";
import {
  EmptyTrashModal,
  DeleteModal,
  DeleteForeverModal,
} from "./FileManagerModals";
import { FileManagerToolbar } from "./FileManagerToolbar";
import { FileList } from "./FileList";
import { MultiSelectIndicator } from "./MultiSelectIndicator";

export const FileManager: React.FC = () => {
  const {
    files,
    selectedFiles,
    viewMode,
    currentPath,
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
    emptyTrash,
    shareFiles,
    starFiles,
    downloadFiles,
    setRenameTarget,
    deleteFiles,
    restoreFiles,
    deleteForever,
    setShareLinkModalOpen,
  } = useApp();

  const { showToast } = useToast();
  const [emptyTrashModalOpen, setEmptyTrashModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteForeverModalOpen, setDeleteForeverModalOpen] = useState(false);

  const canCreateFolder = currentPath[0] === "My Files";
  const isTrashView = currentPath[0] === "Trash";
  const isSharedView = currentPath[0] === "Shared";
  const isStarredView = currentPath[0] === "Starred";
  const hasTrashFiles = isTrashView && files.length > 0;

  const handleEmptyTrash = async () => {
    setEmptyTrashModalOpen(false);
    try {
      const result = await emptyTrash();
      handleClearSelection(); // Clear selection after successful deletion
      showToast(
        result?.message ||
          `Successfully deleted ${files.length} item(s) from trash`,
        "success",
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to empty trash:", error);
      showToast(
        errorMessage || "Failed to empty trash. Please try again.",
        "error",
      );
    }
  };

  const handleDelete = async () => {
    setDeleteModalOpen(false);
    try {
      await deleteFiles(selectedFiles);
      const count = selectedFiles.length;
      handleClearSelection(); // Clear selection after successful deletion
      showToast(
        `Moved ${count} item${count !== 1 ? "s" : ""} to trash`,
        "success",
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to delete:", error);
      showToast(errorMessage || "Failed to delete. Please try again.", "error");
    }
  };

  const handleDeleteForever = async () => {
    setDeleteForeverModalOpen(false);
    try {
      await deleteForever(selectedFiles);
      const count = selectedFiles.length;
      handleClearSelection(); // Clear selection after successful deletion
      showToast(
        `Permanently deleted ${count} item${count !== 1 ? "s" : ""}`,
        "success",
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to delete forever:", error);
      showToast(
        errorMessage || "Failed to permanently delete. Please try again.",
        "error",
      );
    }
  };

  const handleRestore = async () => {
    try {
      const result = await restoreFiles(selectedFiles);
      const count = selectedFiles.length;
      handleClearSelection(); // Clear selection after successful restore
      showToast(
        result?.message ||
          `Restored ${count} item${count !== 1 ? "s" : ""} from trash`,
        "success",
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to restore:", error);
      showToast(
        errorMessage || "Failed to restore files. Please try again.",
        "error",
      );
    }
  };

  const dragSelectingRef = useRef(false);
  const managerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
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
    [
      removeSelectedFile,
      isMobile,
      multiSelectMode,
      selectedFiles.length,
      setMultiSelectMode,
    ],
  );

  // Filter out deleted files from selection
  useEffect(() => {
    const validSelectedFiles = selectedFiles.filter((id) =>
      files.some((f) => f.id === id),
    );
    if (validSelectedFiles.length !== selectedFiles.length) {
      setSelectedFiles(validSelectedFiles);
    }
  }, [files, selectedFiles, setSelectedFiles]);

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (dragSelectingRef.current) return;

      const manager = managerRef.current;
      if (manager && !manager.contains(e.target as Node)) {
        handleClearSelection();
      }
    };

    document.addEventListener("click", handleDocumentClick);

    const handleDrag = (ev: DragEvent) => {
      if (!isMobile) {
        moveDragPreview(ev.clientX, ev.clientY);
      }
    };
    document.addEventListener("dragover", handleDrag);

    return () => {
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("dragover", handleDrag);
    };
  }, [handleClearSelection, isMobile]);

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
      const fileIds = files.map((f) => f.id);
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
    if (currentPath[0] === "Trash") {
      return;
    }

    if (file.type === "folder") {
      openFolder(file);
    } else {
      if (file.mimeType && file.mimeType.startsWith("image/")) {
        setImageViewerFile(file);
      } else if (ONLYOFFICE_EXTS.has(getExt(file.name))) {
        setDocumentViewerFile?.(file);
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
    [selectedFiles, setSelectedFiles],
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
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(getTransparentImage(), 0, 0);
    // mark global dragging state (used to suppress tooltips)
    document.body.classList.add("is-dragging");
    createDragPreview(
      selectedFiles.includes(fileId) ? selectedFiles : [fileId],
      e.clientX,
      e.clientY,
      isMobile,
    );
  };

  const handleDragEnd = () => {
    setDraggingIds([]);
    setDragOverFolder(null);
    removeDragPreview();
    document.body.classList.remove("is-dragging");
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
    if (dragSelectingRef.current || draggingIds.length === 0) return;
    setDragOverFolder(null);
    removeDragPreview();
    await animateFlyToFolder(draggingIds, folderId);
    await moveFiles(draggingIds, folderId);
    setDraggingIds([]);
    document.body.classList.remove("is-dragging");
    closeMultiSelectIfMobile();
  };

  // Calculate shared/starred status for selected files
  const selectedItems = files.filter((f) => selectedFiles.includes(f.id));
  const allShared =
    selectedItems.length > 0 && selectedItems.every((f) => f.shared);
  const allStarred =
    selectedItems.length > 0 && selectedItems.every((f) => f.starred);

  const handleShare = async () => {
    const links = await shareFiles(selectedFiles, !allShared);
    if (!allShared) {
      const base = window.location.origin;
      const list = Object.values(links).map((t) => `${base}/s/${t}`);
      setShareLinkModalOpen(true, list);
    }
    closeMultiSelectIfMobile();
  };

  const handleStar = () => {
    starFiles(selectedFiles, !allStarred);
    closeMultiSelectIfMobile();
  };

  const handleRename = () => {
    if (selectedFiles.length === 1) {
      const file = files.find((f) => f.id === selectedFiles[0]);
      if (file) setRenameTarget(file);
      closeMultiSelectIfMobile();
    }
  };

  return (
    <div
      className={`${isMobile ? "p-3" : "p-6 md:p-8"} space-y-6 md:space-y-8`}
      ref={managerRef}
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
        className={`${isMobile ? "flex-col space-y-3 px-3 py-3" : "flex items-center justify-between px-6 py-4"} rounded-xl card-premium mb-4 transition-all duration-200 animate-slideDown`}
      >
        <div className={`${isMobile ? "w-full" : "flex-1 min-w-0"}`}>
          <Breadcrumbs />
        </div>

        <FileManagerToolbar
          isMobile={isMobile}
          viewMode={viewMode}
          sortBy={sortBy}
          sortOrder={sortOrder}
          selectedFiles={selectedFiles}
          isTrashView={isTrashView}
          isSharedView={isSharedView}
          isStarredView={isStarredView}
          hasTrashFiles={hasTrashFiles}
          canCreateFolder={canCreateFolder}
          allShared={allShared}
          allStarred={allStarred}
          isDownloading={isDownloading}
          onViewModeChange={setViewMode}
          onSortChange={(by, order) => {
            setSortBy(by);
            setSortOrder(order);
          }}
          onCreateFolder={() => setCreateFolderModalOpen(true)}
          onShare={handleShare}
          onStar={handleStar}
          onDownload={async () => {
            await downloadFiles(selectedFiles);
            closeMultiSelectIfMobile();
          }}
          onRename={handleRename}
          onDelete={() => setDeleteModalOpen(true)}
          onRestore={handleRestore}
          onDeleteForever={() => setDeleteForeverModalOpen(true)}
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
        onCreateFolder={() => setCreateFolderModalOpen(true)}
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
      <DownloadProgress
        isDownloading={isDownloading}
        hasFolders={selectedFiles.some(
          (id) => files.find((f) => f.id === id)?.type === "folder",
        )}
      />

      <EmptyTrashModal
        isOpen={emptyTrashModalOpen}
        onClose={() => setEmptyTrashModalOpen(false)}
        onConfirm={handleEmptyTrash}
        fileCount={files.length}
      />

      <DeleteModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDelete}
        fileCount={selectedFiles.length}
      />

      <DeleteForeverModal
        isOpen={deleteForeverModalOpen}
        onClose={() => setDeleteForeverModalOpen(false)}
        onConfirm={handleDeleteForever}
        fileCount={selectedFiles.length}
      />
    </div>
  );
};
