import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileItem } from '../../../contexts/AppContext';

interface FileSelectionParams {
  files: FileItem[];
  selectedFiles: string[];
  setSelectedFiles: (ids: string[]) => void;
  addSelectedFile: (id: string) => void;
  removeSelectedFile: (id: string) => void;
  clearSelection: () => void;
  isMobile: boolean;
  folderStack: (string | null)[];
  managerRef: React.RefObject<HTMLDivElement | null>;
  /** Set while a marquee drag is active, so a click that ends the drag doesn't clear the selection. */
  dragSelectingRef: React.MutableRefObject<boolean>;
}

/** Selection: single/ctrl/shift/marquee, mobile multi-select, click-outside-clear, scroll-return. */
export function useFileSelection({
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
}: FileSelectionParams) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const multiSelectModeRef = useRef(multiSelectMode);

  // Keep ref in sync with state
  useEffect(() => {
    multiSelectModeRef.current = multiSelectMode;
  }, [multiSelectMode]);

  // track marquee‐drag state in a ref only (we never read dragSelecting)
  const handleSelectingChange = useCallback(
    (selecting: boolean) => {
      dragSelectingRef.current = selecting;
      setIsSelecting(selecting);
    },
    [dragSelectingRef]
  );

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

  // Click outside the manager clears the selection (unless a marquee drag is ending).
  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (dragSelectingRef.current) return;

      const manager = managerRef.current;
      if (manager && !manager.contains(e.target as Node)) {
        handleClearSelection();
      }
    };

    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [handleClearSelection, managerRef, dragSelectingRef]);

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

  return {
    isSelecting,
    multiSelectMode,
    setMultiSelectMode,
    closeMultiSelectIfMobile,
    handleClearSelection,
    handleRemoveSelectedFile,
    handleSelectingChange,
    handleFileClick,
    handleMarqueeSelection,
    listScrollRequest,
    clearListScrollRequest,
  };
}
