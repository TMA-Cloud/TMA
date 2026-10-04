import { useEffect } from 'react';
import type { FileItem } from '../../../contexts/AppContext';
import { isActivatableTarget, isFileListFocus, isOverlayOpen, isTypingTarget } from './keyboard.helpers';

interface NavigationKeysParams {
  files: FileItem[];
  selectedFiles: string[];
  /** Same action as a double-click: enter a folder or open a file. */
  openItem: (file: FileItem) => void;
  canGoBack: boolean;
  goBack: () => void;
  /** Breadcrumb depth; the parent is the crumb before the last one. */
  pathLength: number;
  navigateTo: (index: number) => void;
}

/** Explorer's navigation keys: Enter opens, Backspace goes back, Alt+Up goes to the parent. */
export function useNavigationKeys({
  files,
  selectedFiles,
  openItem,
  canGoBack,
  goBack,
  pathLength,
  navigateTo,
}: NavigationKeysParams) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Held keys would open or climb once per auto-repeat.
      if (e.repeat || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
      if (isTypingTarget(e.target) || isOverlayOpen()) return;

      if (e.key === 'Enter' && !e.altKey) {
        if (selectedFiles.length !== 1 || !isFileListFocus(e.target) || isActivatableTarget(e.target)) return;
        const file = files.find(f => f.id === selectedFiles[0]);
        if (!file) return;
        e.preventDefault();
        openItem(file);
      } else if (e.key === 'Backspace' && !e.altKey) {
        if (!canGoBack) return;
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowUp' && e.altKey) {
        if (pathLength < 2) return;
        e.preventDefault();
        navigateTo(pathLength - 2);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [files, selectedFiles, openItem, canGoBack, goBack, pathLength, navigateTo]);
}
