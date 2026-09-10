import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useFileOperations } from '../../src/contexts/app/useFileOperations';

describe('file operations', () => {
  it('does not send a share request with an empty selection', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useFileOperations({
        showToast: vi.fn(),
        operationQueue: { add: vi.fn() },
        folderStack: [null],
        refreshFiles: vi.fn(async () => undefined),
        refreshOrResearch: vi.fn(async () => undefined),
      })
    );

    await expect(
      act(async () => {
        await result.current.shareFiles([], true, '7d');
      })
    ).rejects.toThrow('Select at least one item to share');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
