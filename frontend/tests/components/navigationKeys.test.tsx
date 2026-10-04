import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileItem } from '../../src/contexts/AppContext';
import { useNavigationKeys } from '../../src/components/fileManager/hooks/useNavigationKeys';

const files = ['Docs', 'notes.txt'].map((name, i) => ({ id: `f${i}`, name }) as FileItem);

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

function setup({ selectedFiles = ['f0'], canGoBack = true, pathLength = 3 } = {}) {
  const spies = { openItem: vi.fn(), goBack: vi.fn(), navigateTo: vi.fn() };
  renderHook(() => useNavigationKeys({ files, selectedFiles, canGoBack, pathLength, ...spies }));
  return spies;
}

describe('useNavigationKeys', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the single selected item on Enter', () => {
    const { openItem } = setup();
    press('Enter');
    expect(openItem).toHaveBeenCalledWith(files[0]);
  });

  it('ignores Enter with no selection, several selected, or on a focused button', () => {
    expect(setup({ selectedFiles: [] }).openItem).not.toHaveBeenCalled();
    const { openItem } = setup({ selectedFiles: ['f0', 'f1'] });
    press('Enter');
    const button = document.body.appendChild(document.createElement('button'));
    press('Enter', {}, button);
    expect(openItem).not.toHaveBeenCalled();
  });

  it('goes back on Backspace only when there is history', () => {
    const { goBack } = setup();
    press('Backspace');
    expect(goBack).toHaveBeenCalledOnce();

    const noHistory = setup({ canGoBack: false });
    press('Backspace');
    expect(noHistory.goBack).not.toHaveBeenCalled();
  });

  it('climbs to the parent on Alt+Up, but not past the root', () => {
    const { navigateTo } = setup({ pathLength: 3 });
    press('ArrowUp', { altKey: true });
    expect(navigateTo).toHaveBeenCalledWith(1);

    const atRoot = setup({ pathLength: 1 });
    press('ArrowUp', { altKey: true });
    expect(atRoot.navigateTo).not.toHaveBeenCalled();
  });

  it('leaves text fields, open dialogs and held keys alone', () => {
    const { openItem, goBack } = setup();
    const input = document.body.appendChild(document.createElement('input'));
    press('Backspace', {}, input);
    press('Enter', { repeat: true });

    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    press('Enter');
    press('Backspace');

    expect(openItem).not.toHaveBeenCalled();
    expect(goBack).not.toHaveBeenCalled();
  });
});
