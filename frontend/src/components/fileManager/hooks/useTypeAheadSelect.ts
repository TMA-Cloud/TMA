import { useEffect, useMemo, useRef } from 'react';
import type { FileItem } from '../../../contexts/AppContext';
import {
  appendTypeAheadKey,
  findTypeAheadMatch,
  foldForTypeAhead,
  TYPE_AHEAD_RESET_MS,
  type TypeAheadBuffer,
} from '../typeAhead';
import { isFileListFocus, isOverlayOpen } from './keyboard.helpers';

interface TypeAheadSelectParams {
  files: FileItem[];
  selectedFiles: string[];
  /** The outlined item, which the search starts after; the selection stands in without one. */
  focusedId: string | null;
  /** Selects and outlines the match, as the arrow keys do. */
  selectItem: (fileId: string) => void;
  /** Current folder id; navigating drops whatever was typed in the last one. */
  folderId: string | null;
}

const EMPTY_BUFFER: TypeAheadBuffer = { text: '', lastAt: -Infinity };

/** Explorer-style type-ahead: typing a name's first letters selects it. */
export function useTypeAheadSelect({ files, selectedFiles, focusedId, selectItem, folderId }: TypeAheadSelectParams) {
  const bufferRef = useRef<TypeAheadBuffer>(EMPTY_BUFFER);
  const foldedNames = useMemo(() => files.map(file => foldForTypeAhead(file.name)), [files]);

  useEffect(() => {
    bufferRef.current = EMPTY_BUFFER;
  }, [folderId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || [...e.key].length !== 1) return;
      if (!isFileListFocus(e.target) || isOverlayOpen()) return;

      const now = e.timeStamp;
      const typing = now - bufferRef.current.lastAt <= TYPE_AHEAD_RESET_MS && bufferRef.current.text !== '';
      // A lone space still belongs to whatever button has focus.
      if (e.key === ' ' && !typing) return;

      bufferRef.current = appendTypeAheadKey(bufferRef.current, e.key, now);
      e.preventDefault();

      const anchorId = focusedId ?? selectedFiles[selectedFiles.length - 1];
      const currentIndex = anchorId ? files.findIndex(file => file.id === anchorId) : -1;
      const match = files[findTypeAheadMatch(foldedNames, bufferRef.current.text, currentIndex)];
      if (!match) return;
      selectItem(match.id);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [files, foldedNames, selectedFiles, focusedId, selectItem]);
}
