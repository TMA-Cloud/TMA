import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileItem } from '../../../contexts/AppContext';
import { isMoveKey, moveIndex, rangeIds } from '../keyboardMove';
import type { SelectionCursor } from './useFileSelection';
import { isFileListFocus, isOverlayOpen } from './keyboard.helpers';

interface ArrowKeySelectParams {
  files: FileItem[];
  selectedFiles: string[];
  setSelectedFiles: (ids: string[]) => void;
  requestListScroll: (fileId: string, align: 'center' | 'nearest') => void;
  viewMode: 'grid' | 'list';
  /** Items per row in grid view, as laid out by the file list. */
  columnCount: number;
  /** Anchor and focus shared with mouse clicks, so keys carry on from the last click. */
  cursorRef: React.MutableRefObject<SelectionCursor>;
}

interface KeyboardNav {
  focusId: string;
  /** The selection this focus belongs to; any other change (a click, a marquee) retires it. */
  selectionKey: string;
  /** Set while focus is outside the list: the outline hides but its place is kept for Tab back in. */
  hidden?: boolean;
}

/** Rows that fit in the scroller, less one so a page jump keeps one row of context. */
function visibleRows(fileId: string | undefined): number {
  const scroller = document.querySelector('main.scroller');
  const item = [...document.querySelectorAll('[data-file-id]')].find(el => el.getAttribute('data-file-id') === fileId);
  const row = item?.closest('[data-index]');
  if (!scroller || !(row instanceof HTMLElement) || row.offsetHeight === 0) return 1;
  return Math.max(1, Math.floor(scroller.clientHeight / row.offsetHeight) - 1);
}

/**
 * Explorer's arrow keys: arrows, Home/End and Page keys move the selection,
 * Shift extends it from the anchor, Ctrl moves only the focus and
 * Ctrl+Space toggles the focused item.
 */
export function useArrowKeySelect({
  files,
  selectedFiles,
  setSelectedFiles,
  requestListScroll,
  viewMode,
  columnCount,
  cursorRef,
}: ArrowKeySelectParams) {
  const [nav, setNav] = useState<KeyboardNav | null>(null);
  const selectionKey = selectedFiles.join('\n');
  const active = nav?.selectionKey === selectionKey ? nav : null;
  const keyboardFocusId = active && !active.hidden ? active.focusId : null;
  /** The item keys move from: the outline, else the last click, else the selection's last id. */
  const currentFocusId = useCallback((): string | undefined => {
    if (active) return active.focusId;
    const clicked = cursorRef.current.focusId;
    if (clicked && files.some(file => file.id === clicked)) return clicked;
    return selectedFiles[selectedFiles.length - 1];
  }, [active, files, selectedFiles, cursorRef]);

  /** True while the last input was Tab, so focus that arrives from code or a click is not a Tab-in. */
  const tabbedRef = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      tabbedRef.current = e.key === 'Tab';
    };
    const onPointer = () => {
      tabbedRef.current = false;
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  useEffect(() => {
    const apply = (next: string[], focusId: string, anchorId: string | null) => {
      if (next !== selectedFiles) setSelectedFiles(next);
      cursorRef.current = { anchorId, focusId };
      setNav({ focusId, selectionKey: next.join('\n') });
      requestListScroll(focusId, 'nearest');
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.isComposing) return;
      if (!isFileListFocus(e.target) || isOverlayOpen()) return;

      const focusId = currentFocusId();
      const focusIndex = focusId ? files.findIndex(file => file.id === focusId) : -1;

      if (e.key === ' ' && e.ctrlKey && !e.shiftKey) {
        const id = files[focusIndex]?.id;
        if (!id) return;
        e.preventDefault();
        apply(selectedFiles.includes(id) ? selectedFiles.filter(s => s !== id) : [...selectedFiles, id], id, id);
        return;
      }

      if (!isMoveKey(e.key)) return;
      // Details-style list rows have no neighbours to the side.
      if (viewMode === 'list' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      const columns = viewMode === 'grid' ? Math.max(1, columnCount) : 1;
      const target = files[moveIndex(e.key, focusIndex, files.length, columns, visibleRows(focusId))];
      if (!target) return;
      e.preventDefault();

      if (e.shiftKey) {
        // The anchor from the last click or plain move; an anchor from another folder falls back.
        const ids = files.map(file => file.id);
        const anchorIndex = [cursorRef.current.anchorId, focusId, target.id]
          .map(id => (id ? ids.indexOf(id) : -1))
          .find(index => index >= 0) as number;
        apply(rangeIds(ids, anchorIndex, ids.indexOf(target.id)), target.id, ids[anchorIndex] ?? target.id);
      } else if (e.ctrlKey) {
        apply(selectedFiles, target.id, cursorRef.current.anchorId);
      } else {
        apply([target.id], target.id, target.id);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    active,
    currentFocusId,
    files,
    selectedFiles,
    setSelectedFiles,
    requestListScroll,
    viewMode,
    columnCount,
    cursorRef,
  ]);

  // Tabbing in returns to the item you were last on: the outlined one, else the last
  // clicked (the selection's last id). An empty selection takes the first item too, so
  // the first arrow press moves on from it instead of skipping it as Explorer does.
  // Only a real Tab counts: a click, or a dialog handing focus back, changes nothing.
  const onListFocus = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      if (!tabbedRef.current || e.target !== e.currentTarget) return;
      if (active) {
        if (active.hidden) setNav({ ...active, hidden: false });
        requestListScroll(active.focusId, 'nearest');
        return;
      }
      const leadId = currentFocusId();
      const lead = files.find(file => file.id === leadId) ?? files[0];
      if (!lead) return;
      const next = selectedFiles.length > 0 ? selectedFiles : [lead.id];
      if (next !== selectedFiles) setSelectedFiles(next);
      const anchorId = next !== selectedFiles ? lead.id : (cursorRef.current.anchorId ?? lead.id);
      cursorRef.current = { anchorId, focusId: lead.id };
      setNav({ focusId: lead.id, selectionKey: next.join('\n') });
      requestListScroll(lead.id, 'nearest');
    },
    [active, currentFocusId, files, selectedFiles, setSelectedFiles, requestListScroll, cursorRef]
  );

  // Tabbing out hides the outline. relatedTarget is null when Tab leaves for the
  // browser chrome, so only a move inside the list keeps it showing.
  const onListBlur = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setNav(prev => (prev ? { ...prev, hidden: true } : prev));
  }, []);

  // Clicking a file focuses the list, as in Explorer, so the arrows work on it next.
  // The marquee's preventDefault on mousedown would otherwise keep focus where it was.
  const onListMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.currentTarget.focus({ preventScroll: true });
  }, []);

  // Selects one item and outlines it, for keys handled elsewhere such as type-ahead.
  const focusItem = useCallback(
    (fileId: string) => {
      setSelectedFiles([fileId]);
      cursorRef.current = { anchorId: fileId, focusId: fileId };
      setNav({ focusId: fileId, selectionKey: fileId });
      requestListScroll(fileId, 'nearest');
    },
    [setSelectedFiles, requestListScroll, cursorRef]
  );

  return { keyboardFocusId, focusItem, onListFocus, onListBlur, onListMouseDown };
}
