import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContextType } from '../../src/contexts/AppContext';

const useAppMock = vi.fn();

vi.mock('../../src/contexts/AppContext', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/contexts/AppContext')>();
  return { ...actual, useApp: () => useAppMock() };
});

import { useScrollRestoration } from '../../src/hooks/useScrollRestoration';

const ROOT = 'My Files/';
const CHILD = 'My Files//folder-1';

function context(
  folderStack: (string | null)[],
  listedLocation: string | null,
  navRestoresScroll = false,
  page = 'My Files'
): AppContextType {
  return {
    currentPath: [page, ...folderStack.slice(1).map(String)],
    folderStack,
    listedLocation,
    navRestoresScroll,
  } as unknown as AppContextType;
}

function setup() {
  const scroller = document.createElement('main');
  document.body.appendChild(scroller);
  const ref = { current: scroller };
  useAppMock.mockReturnValue(context([null], ROOT));
  const { rerender } = renderHook(() => useScrollRestoration(ref));
  const scrollTo = (top: number) => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  };
  return { scroller, rerender, scrollTo };
}

describe('useScrollRestoration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('leaves the old listing where it is until the next one has loaded', () => {
    const { scroller, rerender, scrollTo } = setup();
    scrollTo(250);

    useAppMock.mockReturnValue(context([null, 'folder-1'], ROOT));
    rerender();
    expect(scroller.scrollTop).toBe(250);

    useAppMock.mockReturnValue(context([null, 'folder-1'], CHILD));
    rerender();
    expect(scroller.scrollTop).toBe(0);
  });

  it('restores the saved offset when going back to a seen folder', () => {
    const { scroller, rerender, scrollTo } = setup();
    scrollTo(250);
    useAppMock.mockReturnValue(context([null, 'folder-1'], CHILD));
    rerender();
    scrollTo(40);

    useAppMock.mockReturnValue(context([null], CHILD, true));
    rerender();
    expect(scroller.scrollTop).toBe(40);

    useAppMock.mockReturnValue(context([null], ROOT, true));
    rerender();
    expect(scroller.scrollTop).toBe(250);
  });

  it('starts a new navigation at the top even for a folder seen before', () => {
    const { scroller, rerender, scrollTo } = setup();
    scrollTo(250);
    useAppMock.mockReturnValue(context([null, 'folder-1'], CHILD));
    rerender();
    scrollTo(40);
    useAppMock.mockReturnValue(context([null], ROOT, true));
    rerender();

    useAppMock.mockReturnValue(context([null, 'folder-1'], CHILD, false));
    rerender();
    expect(scroller.scrollTop).toBe(0);
  });

  it('moves at once on pages that have no listing to wait for', () => {
    const { scroller, rerender, scrollTo } = setup();
    scrollTo(250);

    useAppMock.mockReturnValue(context([null], ROOT, false, 'Dashboard'));
    rerender();
    expect(scroller.scrollTop).toBe(0);
  });
});
