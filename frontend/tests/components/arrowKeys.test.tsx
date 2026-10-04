import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileItem } from '../../src/contexts/AppContext';
import { useArrowKeySelect } from '../../src/components/fileManager/hooks/useArrowKeySelect';
import { moveIndex, rangeIds } from '../../src/components/fileManager/keyboardMove';

describe('moveIndex', () => {
  // A 3-column grid of 8 items:  0 1 2 / 3 4 5 / 6 7
  const grid = (key: Parameters<typeof moveIndex>[0], from: number, pageRows = 1) =>
    moveIndex(key, from, 8, 3, pageRows);

  it('steps sideways and stops at the ends', () => {
    expect(grid('ArrowRight', 2)).toBe(3);
    expect(grid('ArrowLeft', 3)).toBe(2);
    expect(grid('ArrowLeft', 0)).toBe(0);
    expect(grid('ArrowRight', 7)).toBe(7);
  });

  it('moves by rows and keeps the column', () => {
    expect(grid('ArrowDown', 1)).toBe(4);
    expect(grid('ArrowUp', 4)).toBe(1);
    expect(grid('ArrowUp', 1)).toBe(1);
  });

  it('lands on the last item when the row below is short', () => {
    expect(grid('ArrowDown', 5)).toBe(7);
    expect(grid('ArrowDown', 7)).toBe(7);
  });

  it('jumps a page of rows, clamped to the first and last row', () => {
    expect(grid('PageDown', 0, 2)).toBe(6);
    expect(grid('PageDown', 2, 5)).toBe(7);
    expect(grid('PageUp', 7, 5)).toBe(1);
  });

  it('goes to the ends with Home and End', () => {
    expect(grid('Home', 5)).toBe(0);
    expect(grid('End', 1)).toBe(7);
  });

  it('starts at the first item when nothing is focused, except End', () => {
    expect(grid('ArrowDown', -1)).toBe(0);
    expect(grid('ArrowUp', -1)).toBe(0);
    expect(grid('End', -1)).toBe(7);
    expect(moveIndex('ArrowDown', -1, 0, 1, 1)).toBe(-1);
  });
});

describe('rangeIds', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('runs from the anchor to the focus in either direction', () => {
    expect(rangeIds(ids, 1, 3)).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 3, 1)).toEqual(['d', 'c', 'b']);
    expect(rangeIds(ids, 2, 2)).toEqual(['c']);
  });
});

describe('useArrowKeySelect', () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id }) as FileItem);
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, ...init }));
    });

  /** Feeds each new selection back in, as the app context would. */
  function setup(viewMode: 'grid' | 'list' = 'list', initial: string[] = [], anchor: string | null = null) {
    const requestListScroll = vi.fn();
    const cursorRef = { current: { anchorId: anchor, focusId: null as string | null } };
    let selection = initial;
    const setSelectedFiles = vi.fn((ids: string[]) => {
      selection = ids;
    });
    const hook = renderHook(() =>
      useArrowKeySelect({
        files,
        selectedFiles: selection,
        setSelectedFiles,
        requestListScroll,
        viewMode,
        columnCount: 2,
        cursorRef,
      })
    );
    const pressAndRender = (key: string, init?: KeyboardEventInit) => {
      press(key, init);
      hook.rerender();
    };
    return { hook, pressAndRender, selection: () => selection, requestListScroll, cursorRef };
  }

  it('moves a single selection and scrolls to it', () => {
    const { pressAndRender, selection, requestListScroll } = setup('list', ['b']);
    pressAndRender('ArrowDown');
    expect(selection()).toEqual(['c']);
    expect(requestListScroll).toHaveBeenLastCalledWith('c', 'nearest');
  });

  it('extends from a fixed anchor with Shift, shrinking when it turns back', () => {
    const { pressAndRender, selection } = setup('list', ['b']);
    pressAndRender('ArrowDown', { shiftKey: true });
    pressAndRender('ArrowDown', { shiftKey: true });
    expect(selection()).toEqual(['b', 'c', 'd']);
    pressAndRender('ArrowUp', { shiftKey: true });
    expect(selection()).toEqual(['b', 'c']);
  });

  it('extends from the anchor a Shift-click left, not from the end of the selection', () => {
    // Clicked c, then Shift-clicked a: the selection is c..a with c as the anchor.
    const { pressAndRender, selection } = setup('list', ['c', 'b', 'a'], 'c');
    pressAndRender('ArrowDown', { shiftKey: true });
    expect(selection()).toEqual(['c', 'b']);
  });

  it('moves on from an item a Ctrl-click just deselected', () => {
    // Clicked a, Ctrl-clicked c, then Ctrl-clicked c again to drop it: c keeps the focus.
    const { pressAndRender, selection, cursorRef } = setup('list', ['a'], 'c');
    cursorRef.current.focusId = 'c';
    pressAndRender('ArrowDown', { shiftKey: true });
    expect(selection()).toEqual(['c', 'd']);
  });

  it('moves focus alone with Ctrl and toggles it with Ctrl+Space', () => {
    const { hook, pressAndRender, selection } = setup('list', ['a']);
    pressAndRender('ArrowDown', { ctrlKey: true });
    pressAndRender('ArrowDown', { ctrlKey: true });
    expect(selection()).toEqual(['a']);
    expect(hook.result.current.keyboardFocusId).toBe('c');
    pressAndRender(' ', { ctrlKey: true });
    expect(selection()).toEqual(['a', 'c']);
  });

  it('leaves the arrows to another control once Tab has moved focus out of the list', () => {
    const { selection } = setup('list', ['b']);
    const list = document.body.appendChild(document.createElement('div'));
    list.className = 'file-list';
    const button = document.body.appendChild(document.createElement('button'));

    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(selection()).toEqual(['b']);

    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(selection()).toEqual(['c']);
    list.remove();
    button.remove();
  });

  it('moves by grid rows, and ignores Left/Right in list view', () => {
    const grid = setup('grid', ['a']);
    grid.pressAndRender('ArrowDown');
    expect(grid.selection()).toEqual(['c']);
    grid.hook.unmount();

    const list = setup('list', ['a']);
    list.pressAndRender('ArrowRight');
    expect(list.selection()).toEqual(['a']);
  });

  /** A listbox wired to the hook's latest handlers, plus a button to Tab out to. */
  function renderList(hook: ReturnType<typeof setup>['hook']) {
    const view = render(
      <>
        <div
          role="listbox"
          tabIndex={0}
          onFocus={e => hook.result.current.onListFocus(e)}
          onBlur={e => hook.result.current.onListBlur(e)}
          onMouseDown={e => hook.result.current.onListMouseDown(e)}
        />
        <button>next</button>
      </>
    );
    const tabIn = () => {
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        view.getByRole('listbox').focus();
      });
      hook.rerender();
    };
    // A dialog closing, for example, hands focus back from code with no Tab pressed.
    const focusFromCode = () => {
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        view.getByRole('listbox').focus();
      });
      hook.rerender();
    };
    const tabOut = () => {
      act(() => view.getByRole('button').focus());
      hook.rerender();
    };
    const click = () => {
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        fireEvent.pointerDown(view.getByRole('listbox'));
        fireEvent.mouseDown(view.getByRole('listbox'));
      });
      hook.rerender();
    };
    return { tabIn, tabOut, click, focusFromCode };
  }

  it('selects and outlines the first item when tabbed into with nothing selected', () => {
    const { hook, pressAndRender, selection } = setup('list', []);
    renderList(hook).tabIn();
    expect(selection()).toEqual(['a']);
    expect(hook.result.current.keyboardFocusId).toBe('a');

    // The first arrow moves on from the outlined item instead of skipping it.
    pressAndRender('ArrowDown');
    expect(selection()).toEqual(['b']);
  });

  it('focuses the list on a click without selecting or scrolling to the first item', () => {
    // Even right after a Tab elsewhere, the click decides what gets selected.
    const { hook, selection, requestListScroll } = setup('list', []);
    const list = renderList(hook);
    list.click();
    expect(document.activeElement?.getAttribute('role')).toBe('listbox');
    expect(selection()).toEqual([]);
    expect(requestListScroll).not.toHaveBeenCalled();
    expect(hook.result.current.keyboardFocusId).toBeNull();
  });

  it('changes nothing when a dialog hands focus back to the list', () => {
    const { hook, selection, requestListScroll } = setup('list', []);
    renderList(hook).focusFromCode();
    expect(selection()).toEqual([]);
    expect(requestListScroll).not.toHaveBeenCalled();
    expect(hook.result.current.keyboardFocusId).toBeNull();
  });

  it('returns to the last clicked item when tabbed into with a selection', () => {
    const { hook } = setup('list', ['d', 'b']);
    renderList(hook).tabIn();
    expect(hook.result.current.keyboardFocusId).toBe('b');
  });

  it('hides the outline on Tab out and brings it back to the same item on Tab in', () => {
    const { hook, pressAndRender, selection } = setup('list', ['a']);
    const list = renderList(hook);
    list.tabIn();
    pressAndRender('ArrowDown', { ctrlKey: true });
    pressAndRender('ArrowDown', { ctrlKey: true });
    expect(hook.result.current.keyboardFocusId).toBe('c');

    list.tabOut();
    expect(hook.result.current.keyboardFocusId).toBeNull();

    list.tabIn();
    expect(hook.result.current.keyboardFocusId).toBe('c');
    pressAndRender('ArrowDown');
    expect(selection()).toEqual(['d']);
  });
});
