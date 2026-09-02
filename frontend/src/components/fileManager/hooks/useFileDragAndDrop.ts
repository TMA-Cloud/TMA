import { useEffect, useState } from 'react';
import type { AccountPermission } from '../../../contexts/AuthContext';
import { getErrorMessage } from '../../../utils/errorUtils';
import {
  animateFlyToFolder,
  createDragPreview,
  getTransparentImage,
  moveDragPreview,
  removeDragPreview,
} from '../utils/dragPreview';

type ToastType = 'success' | 'error' | 'info';

interface FileDragAndDropParams {
  selectedFiles: string[];
  setSelectedFiles: (ids: string[]) => void;
  isMobile: boolean;
  dragSelectingRef: React.MutableRefObject<boolean>;
  can: (permission: AccountPermission) => boolean;
  moveFiles: (ids: string[], parentId: string | null) => Promise<void>;
  closeMultiSelectIfMobile: () => void;
  showToast: (message: string, type?: ToastType) => void;
}

/** Internal drag-to-move onto a folder, with the custom preview and fly-to-folder animation. */
export function useFileDragAndDrop({
  selectedFiles,
  setSelectedFiles,
  isMobile,
  dragSelectingRef,
  can,
  moveFiles,
  closeMultiSelectIfMobile,
  showToast,
}: FileDragAndDropParams) {
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  // Clean up is-dragging class on unmount or when drag ends unexpectedly
  useEffect(() => {
    if (draggingIds.length === 0) {
      document.body.classList.remove('is-dragging');
    }
    return () => {
      document.body.classList.remove('is-dragging');
    };
  }, [draggingIds]);

  // Keep the custom drag preview following the cursor while dragging.
  useEffect(() => {
    const handleDrag = (ev: DragEvent) => {
      if (!isMobile) {
        moveDragPreview(ev.clientX, ev.clientY);
      }
    };
    document.addEventListener('dragover', handleDrag);
    return () => document.removeEventListener('dragover', handleDrag);
  }, [isMobile]);

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

  return {
    draggingIds,
    setDraggingIds,
    dragOverFolder,
    handleDragStart,
    handleDragEnd,
    handleFolderDragOver,
    handleFolderDragLeave,
    handleFolderDrop,
  };
}
