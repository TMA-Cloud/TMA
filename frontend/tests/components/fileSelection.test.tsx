import type React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileItem } from '../../src/contexts/AppContext';
import { useFileSelection } from '../../src/components/fileManager/hooks/useFileSelection';

const files = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id }) as FileItem);

/** Feeds each new selection back in, as the app context would. */
function setup(initial: string[] = []) {
  let selection = initial;
  const setSelectedFiles = vi.fn((ids: string[]) => {
    selection = ids;
  });
  const hook = renderHook(() =>
    useFileSelection({
      files,
      selectedFiles: selection,
      setSelectedFiles,
      addSelectedFile: id => setSelectedFiles([...selection, id]),
      removeSelectedFile: id => setSelectedFiles(selection.filter(s => s !== id)),
      clearSelection: () => setSelectedFiles([]),
      isMobile: false,
      folderStack: [null],
      managerRef: { current: null },
      dragSelectingRef: { current: false },
    })
  );
  const click = (id: string, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
    const event = { preventDefault() {}, stopPropagation() {}, ...mods } as unknown as React.MouseEvent;
    act(() => hook.result.current.handleFileClick(id, event));
    hook.rerender();
  };
  return { hook, click, selection: () => selection };
}

describe('useFileSelection clicks', () => {
  it('replaces the selection with the range from the anchor on Shift-click, as Explorer does', () => {
    const { click, selection } = setup();
    click('b');
    click('d', { shiftKey: true });
    expect(selection()).toEqual(['b', 'c', 'd']);
    // The anchor stays on b, so a second Shift-click re-ranges from it.
    click('a', { shiftKey: true });
    expect(selection()).toEqual(['b', 'a']);
  });

  it('adds the range to the selection on Ctrl+Shift-click', () => {
    const { click, selection } = setup();
    click('a');
    click('d', { ctrlKey: true });
    click('e', { ctrlKey: true, shiftKey: true });
    expect(selection()).toEqual(['a', 'd', 'e']);
  });

  it('moves the anchor on Ctrl-click and puts the clicked item last', () => {
    const { hook, click, selection } = setup();
    click('a');
    click('c', { ctrlKey: true });
    expect(hook.result.current.selectionCursorRef.current).toEqual({ anchorId: 'c', focusId: 'c' });
    click('e', { shiftKey: true });
    expect(selection()).toEqual(['c', 'd', 'e']);
  });
});
