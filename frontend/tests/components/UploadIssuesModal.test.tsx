import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UploadIssuesModal } from '../../src/components/upload/UploadIssuesModal';
import type { AppContextType, UploadFailure } from '../../src/contexts/AppContext';

/**
 * Rejections used to arrive as one toast each, which stacked and expired before
 * they could be read. The dialog has to hold every one of them until the user
 * closes it, and stay readable when the same problem hits dozens of files.
 */

const dismiss = vi.fn();

function makeContext(uploadFailures: UploadFailure[], uploadSavedCount = 0): AppContextType {
  return { uploadFailures, uploadSavedCount, dismissUploadFailures: dismiss } as unknown as AppContextType;
}

const useAppMock = vi.fn();
vi.mock('../../src/contexts/AppContext', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/contexts/AppContext')>();
  return { ...actual, useApp: () => useAppMock() };
});

vi.mock('../../src/hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

describe('upload issues dialog', () => {
  it('stays closed when the run had nothing to report', () => {
    useAppMock.mockImplementation(() => makeContext([]));
    render(<UploadIssuesModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gathers one heading per problem and names every file under it', () => {
    useAppMock.mockImplementation(() =>
      makeContext([
        { fileName: 'clip.mpeg', reason: 'File content does not match extension .mpeg', folderPath: 'Trip/Videos' },
        { fileName: 'beach.mp4', reason: 'File content does not match extension .mp4', folderPath: 'Trip/Videos' },
        { fileName: 'scan.tiff', reason: 'File too large' },
      ])
    );

    render(<UploadIssuesModal />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('3 files not uploaded')).toBeInTheDocument();
    // The two extension mismatches differ only in the extension the server
    // named, so they belong under one heading rather than two.
    expect(screen.getByText('Content does not match the file extension')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.getByText('File too large')).toBeInTheDocument();
    for (const name of ['clip.mpeg', 'beach.mp4', 'scan.tiff']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Trip/Videos')).toHaveLength(2);
  });

  it('caps a long list rather than rendering thousands of rows', () => {
    useAppMock.mockImplementation(() =>
      makeContext(
        Array.from({ length: 120 }, (_, i) => ({
          fileName: `file-${i}.mp4`,
          reason: 'File content does not match extension .mp4',
        }))
      )
    );

    render(<UploadIssuesModal />);

    expect(screen.getByText('120 files')).toBeInTheDocument();
    expect(screen.getByText('and 70 more files')).toBeInTheDocument();
    expect(screen.queryByText('file-119.mp4')).toBeNull();
  });

  it('does not claim other files were saved when the run was one file', () => {
    useAppMock.mockImplementation(() =>
      makeContext([{ fileName: 'clip.mpeg', reason: 'File content does not match extension .mpeg' }], 0)
    );

    render(<UploadIssuesModal />);

    expect(screen.getByText(/This file was not uploaded/)).toBeInTheDocument();
    // No count of files that landed, because none did and none were asked to.
    expect(screen.queryByText(/of 1 file/)).toBeNull();
  });

  it('reports the run as a count out of its total when part of it landed', () => {
    useAppMock.mockImplementation(() =>
      makeContext(
        [
          { fileName: 'clip.mp4', reason: 'File too large' },
          { fileName: 'clip2.mp4', reason: 'File too large' },
        ],
        2
      )
    );

    render(<UploadIssuesModal />);

    // Both counts are 2, which is exactly why the total has to be spelled out.
    expect(screen.getByText('2 of 4 files were uploaded. Fix the 2 below and upload them again.')).toBeInTheDocument();
  });

  it('closes only when the user acknowledges it', async () => {
    dismiss.mockClear();
    useAppMock.mockImplementation(() => makeContext([{ fileName: 'clip.mp4', reason: 'File too large' }]));

    render(<UploadIssuesModal />);
    expect(dismiss).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(dismiss).toHaveBeenCalled();
  });
});
