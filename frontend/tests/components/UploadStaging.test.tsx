import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UploadModal } from '../../src/components/upload/UploadModal';
import type { AppContextType, UploadModalInitialEntry } from '../../src/contexts/AppContext';

/**
 * The modal takes drag-and-dropped entries from the provider rather than
 * scanning them itself, so staging has to be exactly-once: an entry list
 * consumed twice is an upload of every file twice.
 */

const entryList = (count: number): UploadModalInitialEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    file: new File(['x'], `file-${i}.txt`),
    relativePath: `Docs/file-${i}.txt`,
  }));

function makeContext(initialEntries: UploadModalInitialEntry[]): AppContextType {
  return {
    uploadModalOpen: true,
    setUploadModalOpen: vi.fn(),
    uploadModalProcessing: false,
    setUploadModalProcessing: vi.fn(),
    uploadModalProcessingRequestId: null,
    setUploadModalProcessingRequestId: vi.fn(),
    uploadScanCount: 0,
    setUploadScanCount: vi.fn(),
    uploadModalInitialEntries: initialEntries,
    // Recreated per render, exactly as the provider does — the effect that
    // consumes entries must not treat that as a fresh batch to stage.
    clearUploadModalInitialEntries: vi.fn(),
    files: [],
    uploadFileWithProgress: vi.fn(),
    replaceFileWithProgress: vi.fn(),
    uploadEntriesBulk: vi.fn(),
    uploadProgress: [],
    cancelUpload: vi.fn(),
    cancelUploadGroup: vi.fn(),
  } as unknown as AppContextType;
}

const useAppMock = vi.fn();
vi.mock('../../src/contexts/AppContext', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/contexts/AppContext')>();
  return { ...actual, useApp: () => useAppMock() };
});

vi.mock('../../src/hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

describe('staging dropped entries', () => {
  it('stages a dropped folder once, even when the effect runs twice', async () => {
    const entries = entryList(3);
    // A fresh context object per render mirrors the provider's inline
    // callbacks, whose identity changes on every render.
    useAppMock.mockImplementation(() => makeContext(entries));

    render(
      <StrictMode>
        <UploadModal />
      </StrictMode>
    );

    await waitFor(() => expect(screen.getByText(/Folders to Upload/)).toBeInTheDocument());
    expect(document.body.textContent).toContain('3 items');
  });

  it('still stages a second drop, so the guard blocks repeats and not new work', async () => {
    let entries = entryList(3);
    useAppMock.mockImplementation(() => makeContext(entries));

    const { rerender } = render(
      <StrictMode>
        <UploadModal />
      </StrictMode>
    );
    await waitFor(() => expect(document.body.textContent).toContain('3 items'));

    // A second drop hands over a different array — a new batch, not a re-run.
    entries = entryList(2);
    rerender(
      <StrictMode>
        <UploadModal />
      </StrictMode>
    );

    await waitFor(() => expect(document.body.textContent).toContain('5 items'));
  });
});
