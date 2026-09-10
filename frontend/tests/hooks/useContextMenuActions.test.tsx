import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContextType, FileItem } from '../../src/contexts/AppContext';

const useAppMock = vi.fn();
const shareFiles = vi.fn(async () => ({ 'file-1': '/s/token' }));

vi.mock('../../src/contexts/AppContext', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/contexts/AppContext')>();
  return { ...actual, useApp: () => useAppMock() };
});

vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../src/hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { useContextMenuActions } from '../../src/components/fileManager/hooks/useContextMenuActions';

const file = { id: 'file-1', name: 'Report.pdf', type: 'file', shared: false } as FileItem;

function context(selectedFiles: string[]): AppContextType {
  return {
    selectedFiles,
    files: [file],
    folderStack: [null],
    folderSharedStack: [false],
    currentPath: ['My Files'],
    shareFiles,
    setShareLinkModalOpen: vi.fn(),
  } as unknown as AppContextType;
}

describe('useContextMenuActions sharing', () => {
  beforeEach(() => {
    shareFiles.mockClear();
    useAppMock.mockReturnValue(context(['file-1']));
  });

  it('keeps the selected IDs after the portalled menu click clears the live selection', async () => {
    const { result, rerender } = renderHook(() =>
      useContextMenuActions({
        targetId: 'file-1',
        isMobile: false,
        multiSelectMode: false,
        onClose: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.menuItems.find(item => item.label === 'Add to Shared')?.action();
    });
    expect(result.current.shareExpiryOpen).toBe(true);
    expect(result.current.selectedFilesCount).toBe(1);

    // This is what the file manager's document click handler does after a
    // click in the desktop context-menu portal.
    useAppMock.mockReturnValue(context([]));
    rerender();

    await act(async () => result.current.handleShareExpiry('7d'));

    expect(shareFiles).toHaveBeenCalledWith(['file-1'], true, '7d');
  });
});
