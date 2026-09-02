import { useEffect } from 'react';
import type { FileItem } from '../../../contexts/AppContext';
import { isElectron } from '../../../utils/electronDesktop';

type ToastType = 'success' | 'error' | 'info';

interface FileManagerShortcutsParams {
  files: FileItem[];
  selectedFiles: string[];
  folderStack: (string | null)[];
  isMyFilesView: boolean;
  isTrashView: boolean;
  canUpload: boolean;
  isDeleting: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  uploadFile: (file: File) => Promise<void>;
  uploadFilesBulk: (files: File[]) => Promise<void>;
  clipboardCopy: (ids: string[]) => void;
  clipboardPaste: (parentId: string | null) => Promise<void>;
  setClipboard: (clip: { ids: string[]; action: 'copy' | 'cut' } | null) => void;
  setSelectedFiles: (ids: string[]) => void;
  openInfoModalForSelection: () => void;
  setDeleteModalOpen: (open: boolean) => void;
  showToast: (message: string, type?: ToastType) => void;
}

/** Global keyboard/mouse/paste shortcuts (paste-upload, mouse back/forward, Electron clipboard, Delete). */
export function useFileManagerShortcuts({
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
}: FileManagerShortcutsParams) {
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
}
