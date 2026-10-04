import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileItem } from '../../src/contexts/AppContext';
import { useTypeAheadSelect } from '../../src/components/fileManager/hooks/useTypeAheadSelect';
import {
  appendTypeAheadKey,
  findTypeAheadMatch,
  foldForTypeAhead,
  TYPE_AHEAD_RESET_MS,
} from '../../src/components/fileManager/typeAhead';

const names = ['Apple', 'apricot', 'Banana', 'Été notes', 'Report 2024', 'report final', 'Reports'].map(
  foldForTypeAhead
);

describe('findTypeAheadMatch', () => {
  it('finds the first match from the top when nothing is selected', () => {
    expect(findTypeAheadMatch(names, 'b', -1)).toBe(2);
  });

  it('cycles through items sharing a first letter and wraps around', () => {
    expect(findTypeAheadMatch(names, 'a', 0)).toBe(1);
    expect(findTypeAheadMatch(names, 'a', 1)).toBe(0);
  });

  it('treats a repeated letter as cycling, like Explorer', () => {
    expect(findTypeAheadMatch(names, 'rrr', 4)).toBe(5);
  });

  it('keeps the current item while a longer prefix still matches it', () => {
    expect(findTypeAheadMatch(names, 'rep', 4)).toBe(4);
    expect(findTypeAheadMatch(names, 'report f', 4)).toBe(5);
  });

  it('ignores case and accents', () => {
    expect(findTypeAheadMatch(names, foldForTypeAhead('E'), -1)).toBe(3);
  });

  it('returns -1 when nothing matches', () => {
    expect(findTypeAheadMatch(names, 'zz top', 0)).toBe(-1);
    expect(findTypeAheadMatch([], 'a', -1)).toBe(-1);
  });
});

describe('appendTypeAheadKey', () => {
  it('builds a prefix from quick keys and restarts after a pause', () => {
    const first = appendTypeAheadKey({ text: '', lastAt: -Infinity }, 'R', 0);
    const second = appendTypeAheadKey(first, 'e', 200);
    expect(second.text).toBe('re');
    expect(appendTypeAheadKey(second, 'b', 200 + TYPE_AHEAD_RESET_MS + 1).text).toBe('b');
  });
});

describe('useTypeAheadSelect', () => {
  const files = ['Alpha', 'Beta', 'Bravo'].map((name, i) => ({ id: `f${i}`, name }) as FileItem);
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, ...init }));

  const setup = (selectedFiles: string[] = [], focusedId: string | null = null) => {
    const selectItem = vi.fn();
    renderHook(() => useTypeAheadSelect({ files, selectedFiles, focusedId, selectItem, folderId: null }));
    return { selectItem };
  };

  it('selects the next match after the selection', () => {
    const { selectItem } = setup(['f1']);
    press('b');
    expect(selectItem).toHaveBeenCalledWith('f2');
  });

  it('searches on from the outlined item when there is one', () => {
    const { selectItem } = setup(['f0'], 'f2');
    press('b');
    expect(selectItem).toHaveBeenCalledWith('f1');
  });

  it('leaves shortcuts, text fields and open dialogs alone', () => {
    const { selectItem } = setup();
    press('a', { ctrlKey: true });

    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.remove();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    press('a');
    dialog.remove();

    expect(selectItem).not.toHaveBeenCalled();
  });
});
