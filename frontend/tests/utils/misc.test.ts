import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authFetch } from '../../src/utils/authFetch';
import { copyToClipboard } from '../../src/utils/clipboard';
import { downloadBlob } from '../../src/utils/download';
import { entriesFromDataTransfer, entriesFromFileList } from '../../src/utils/folderUpload';
import { removeUploadProgress, updateUploadProgress, createAutoDismissTimeout } from '../../src/utils/uploadUtils';
import type { UploadProgressItem } from '../../src/utils/uploadUtils';

/* ------------------------------------------------------------------ *
 * authFetch
 * ------------------------------------------------------------------ */

describe('authFetch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('adds the CSRF header and sends cookies', async () => {
    await authFetch('/api/files');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe('include');
    expect((init.headers as Headers).get('X-Requested-With')).toBe('XMLHttpRequest');
  });

  it('does not overwrite a caller-supplied CSRF header', async () => {
    await authFetch('/api/files', { headers: { 'X-Requested-With': 'custom' } });
    expect((fetchMock.mock.calls[0][1].headers as Headers).get('X-Requested-With')).toBe('custom');
  });

  it('preserves other caller headers', async () => {
    await authFetch('/api/files', { headers: { Accept: 'application/zip' } });
    expect((fetchMock.mock.calls[0][1].headers as Headers).get('Accept')).toBe('application/zip');
  });

  it('honours an explicit credentials mode', async () => {
    await authFetch('/api/files', { credentials: 'omit' });
    expect(fetchMock.mock.calls[0][1].credentials).toBe('omit');
  });

  it('passes the method and body straight through', async () => {
    await authFetch('/api/files', { method: 'POST', body: 'payload' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('payload');
  });
});

/* ------------------------------------------------------------------ *
 * downloadBlob
 * ------------------------------------------------------------------ */

describe('downloadBlob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    window.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => vi.useRealTimers());

  it('clicks a temporary anchor carrying the object URL and filename', () => {
    const anchor = document.createElement('a');
    const clickSpy = vi.spyOn(anchor, 'click').mockImplementation(() => {});
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    downloadBlob(new Blob(['x']), 'report.pdf');

    expect(anchor.href).toContain('blob:mock-url');
    expect(anchor.download).toBe('report.pdf');
    expect(clickSpy).toHaveBeenCalled();
  });

  it('removes the anchor from the document afterwards', () => {
    downloadBlob(new Blob(['x']), 'report.pdf');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('revokes the object URL, so the blob can be garbage-collected', () => {
    downloadBlob(new Blob(['x']), 'report.pdf');
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

/* ------------------------------------------------------------------ *
 * copyToClipboard
 * ------------------------------------------------------------------ */

describe('copyToClipboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the async Clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await copyToClipboard('https://share.example.com/s/abc');

    expect(writeText).toHaveBeenCalledWith('https://share.example.com/s/abc');
  });

  it('falls back to execCommand on an insecure origin', async () => {
    vi.stubGlobal('navigator', {});
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    await copyToClipboard('fallback text');

    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('leaves no textarea behind after the fallback', async () => {
    vi.stubGlobal('navigator', {});
    Object.defineProperty(document, 'execCommand', { value: () => true, configurable: true });

    await copyToClipboard('fallback text');

    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('throws when the fallback copy command fails', async () => {
    vi.stubGlobal('navigator', {});
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });

    await expect(copyToClipboard('x')).rejects.toThrow('Copy command failed');
  });

  it('propagates a rejection from the Clipboard API', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(copyToClipboard('x')).rejects.toThrow('denied');
  });
});

/* ------------------------------------------------------------------ *
 * upload progress list operations
 * ------------------------------------------------------------------ */

describe('upload progress list', () => {
  const item = (id: string, extra: Partial<UploadProgressItem> = {}): UploadProgressItem => ({
    id,
    fileName: `${id}.txt`,
    fileSize: 100,
    progress: 0,
    status: 'uploading',
    ...extra,
  });

  describe('removeUploadProgress', () => {
    it('removes the matching entry', () => {
      const result = removeUploadProgress([item('a'), item('b')], 'a');
      expect(result.map(i => i.id)).toEqual(['b']);
    });

    it('leaves the list untouched when the id is unknown', () => {
      const list = [item('a')];
      expect(removeUploadProgress(list, 'zzz')).toEqual(list);
    });

    it('returns a new array rather than mutating in place', () => {
      const list = [item('a')];
      expect(removeUploadProgress(list, 'a')).not.toBe(list);
      expect(list).toHaveLength(1);
    });
  });

  describe('updateUploadProgress', () => {
    it('patches only the targeted entry', () => {
      const result = updateUploadProgress([item('a'), item('b')], 'a', { progress: 50 });
      expect(result[0]?.progress).toBe(50);
      expect(result[1]?.progress).toBe(0);
    });

    it('preserves fields it was not asked to change', () => {
      const result = updateUploadProgress([item('a', { fileName: 'keep.txt' })], 'a', { progress: 50 });
      expect(result[0]?.fileName).toBe('keep.txt');
    });

    it('can move an entry to a terminal status', () => {
      const result = updateUploadProgress([item('a')], 'a', { status: 'completed', progress: 100 });
      expect(result[0]).toMatchObject({ status: 'completed', progress: 100 });
    });

    it('is a no-op for an unknown id', () => {
      const result = updateUploadProgress([item('a')], 'zzz', { progress: 50 });
      expect(result[0]?.progress).toBe(0);
    });
  });

  describe('createAutoDismissTimeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('removes the entry once the delay elapses', () => {
      const setUploadProgress = vi.fn();
      const timeouts = { current: new Map<string, ReturnType<typeof setTimeout>>() };

      createAutoDismissTimeout('a', { current: false }, setUploadProgress, timeouts, 1000);
      expect(setUploadProgress).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(setUploadProgress).toHaveBeenCalledOnce();
    });

    it('defers dismissal while the user is interacting with the panel', () => {
      const setUploadProgress = vi.fn();
      const timeouts = { current: new Map<string, ReturnType<typeof setTimeout>>() };
      const interacting = { current: true };

      createAutoDismissTimeout('a', interacting, setUploadProgress, timeouts, 1000, 500);

      vi.advanceTimersByTime(1000);
      expect(setUploadProgress).not.toHaveBeenCalled();
      expect(timeouts.current.has('a')).toBe(true);

      interacting.current = false;
      vi.advanceTimersByTime(500);
      expect(setUploadProgress).toHaveBeenCalledOnce();
    });

    it('drops its bookkeeping entry once it fires', () => {
      const timeouts = { current: new Map<string, ReturnType<typeof setTimeout>>() };
      timeouts.current.set('a', createAutoDismissTimeout('a', { current: false }, vi.fn(), timeouts, 1000));

      vi.advanceTimersByTime(1000);
      expect(timeouts.current.has('a')).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ *
 * folder upload traversal
 * ------------------------------------------------------------------ */

describe('entriesFromFileList', () => {
  const fileList = (files: File[]) => files as unknown as FileList;

  it('uses webkitRelativePath to preserve the folder structure', () => {
    const file = Object.assign(new File(['x'], 'a.txt'), { webkitRelativePath: 'Docs/sub/a.txt' });
    expect(entriesFromFileList(fileList([file]))[0]?.relativePath).toBe('Docs/sub/a.txt');
  });

  it('falls back to the plain filename when no relative path is present', () => {
    expect(entriesFromFileList(fileList([new File(['x'], 'a.txt')]))[0]?.relativePath).toBe('a.txt');
  });

  it('ignores a blank relative path', () => {
    const file = Object.assign(new File(['x'], 'a.txt'), { webkitRelativePath: '   ' });
    expect(entriesFromFileList(fileList([file]))[0]?.relativePath).toBe('a.txt');
  });

  it('returns one entry per file', () => {
    const files = [new File(['x'], 'a.txt'), new File(['y'], 'b.txt')];
    expect(entriesFromFileList(fileList(files))).toHaveLength(2);
  });
});

describe('entriesFromDataTransfer', () => {
  /** Build the webkit entry shape the traversal walks. */
  function fileEntry(name: string) {
    return {
      isFile: true,
      isDirectory: false,
      name,
      file: (resolve: (f: File) => void) => resolve(new File(['x'], name)),
    };
  }

  function dirEntry(name: string, children: unknown[]) {
    let handedOut = false;
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => ({
        readEntries: (resolve: (entries: unknown[]) => void) => {
          resolve(handedOut ? [] : ((handedOut = true), children));
        },
      }),
    };
  }

  const dataTransfer = (entries: unknown[]) =>
    ({
      items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })),
      files: [],
    }) as unknown as DataTransfer;

  it('returns dropped top-level files with no relative path', async () => {
    const result = await entriesFromDataTransfer(dataTransfer([fileEntry('a.txt')]));
    expect(result).toHaveLength(1);
    expect(result[0]?.relativePath).toBeUndefined();
    expect(result[0]?.file.name).toBe('a.txt');
  });

  it('prefixes files inside a dropped folder with the folder name', async () => {
    const result = await entriesFromDataTransfer(dataTransfer([dirEntry('Docs', [fileEntry('a.txt')])]));
    expect(result[0]?.relativePath).toBe('Docs/a.txt');
  });

  it('walks nested folders, building the full path', async () => {
    const tree = dirEntry('Docs', [dirEntry('sub', [fileEntry('deep.txt')])]);
    const result = await entriesFromDataTransfer(dataTransfer([tree]));
    expect(result[0]?.relativePath).toBe('Docs/sub/deep.txt');
  });

  it('returns an empty list for an empty folder', async () => {
    expect(await entriesFromDataTransfer(dataTransfer([dirEntry('Empty', [])]))).toEqual([]);
  });

  it('falls back to plain files when the browser has no webkitGetAsEntry', async () => {
    const dt = { items: [], files: [new File(['x'], 'a.txt')] } as unknown as DataTransfer;
    const result = await entriesFromDataTransfer(dt);
    expect(result).toHaveLength(1);
    expect(result[0]?.relativePath).toBeUndefined();
  });

  it('ignores non-file drag items such as dropped text', async () => {
    const dt = {
      items: [{ kind: 'string', webkitGetAsEntry: () => null }],
      files: [],
    } as unknown as DataTransfer;
    expect(await entriesFromDataTransfer(dt)).toEqual([]);
  });
});
