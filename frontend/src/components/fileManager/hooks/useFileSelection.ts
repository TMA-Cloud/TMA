import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileItem } from '../../../contexts/AppContext';
import { rangeIds } from '../keyboardMove';

/**
 * Explorer's list cursor, shared by clicks and keys. The anchor is where a Shift
 * range starts; the focus is the item the next arrow key moves from, which can
 * be one a Ctrl-click just deselected.
 */
export interface SelectionCursor {
  anchorId: string | null;
  focusId: string | null;
}

/** `nearest` scrolls only as far as needed, for keyboard moves within view. */
export interface ListScrollRequest {
  fileId: string;
  token: number;
  align?: 'center' | 'nearest';
}

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
  /** Set by a click or Ctrl-click; Shift-click moves only the focus. */
  const selectionCursorRef = useRef<SelectionCursor>({ anchorId: null, focusId: null });
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

  const [listScrollRequest, setListScrollRequest] = useState<ListScrollRequest | null>(null);
  const listScrollTokenRef = useRef(0);
  const clearListScrollRequest = useCallback(() => setListScrollRequest(null), []);
  const requestListScroll = useCallback((fileId: string, align: ListScrollRequest['align'] = 'center') => {
    listScrollTokenRef.current += 1;
    setListScrollRequest({ fileId, token: listScrollTokenRef.current, align });
  }, []);

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
    requestListScroll(id);
  }, [files, selectedFiles, requestListScroll]);

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
      selectionCursorRef.current = { anchorId: fileId, focusId: fileId };
      return;
    }

    const fileIds = files.map(f => f.id);
    const anchorId = selectionCursorRef.current.anchorId ?? selectedFiles[selectedFiles.length - 1];
    const anchorIndex = anchorId ? fileIds.indexOf(anchorId) : -1;
    const clickedIndex = fileIds.indexOf(fileId);

    if (e.shiftKey && anchorIndex >= 0 && clickedIndex >= 0) {
      // Shift replaces the selection with anchor..clicked; Ctrl+Shift adds that range.
      // The clicked item goes last, so the keys carry on from it. The anchor stays.
      const range = rangeIds(fileIds, anchorIndex, clickedIndex);
      const kept = e.ctrlKey || e.metaKey ? selectedFiles.filter(id => !range.includes(id)) : [];
      setSelectedFiles([...kept, ...range]);
      selectionCursorRef.current = { anchorId: fileIds[anchorIndex] ?? fileId, focusId: fileId };
    } else if (e.ctrlKey || e.metaKey) {
      // Multi-select with Ctrl/Cmd
      if (selectedFiles.includes(fileId)) {
        handleRemoveSelectedFile(fileId);
      } else {
        addSelectedFile(fileId);
      }
      selectionCursorRef.current = { anchorId: fileId, focusId: fileId };
    } else {
      // Single select
      setSelectedFiles([fileId]);
      selectionCursorRef.current = { anchorId: fileId, focusId: fileId };
    }
  };

  const handleMarqueeSelection = useCallback(
    (selectedIds: string[], additive: boolean) => {
      // A drag-box selection has no clicked item, so a later Shift range starts from its last id.
      selectionCursorRef.current = { anchorId: null, focusId: null };
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
    requestListScroll,
    selectionCursorRef,
  };
}
