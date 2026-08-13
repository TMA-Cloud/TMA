import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_COPY_TO_PC_BYTES,
  base64ToFile,
  copyFilesToPcClipboard,
  editFileWithDesktopElectron,
  getElectronAppVersion,
  getElectronCloudDriveMode,
  getFilesFromElectronClipboard,
  hasElectronClipboard,
  hasElectronCloudDrive,
  hasElectronOpenOnDesktop,
  isElectron,
  peekElectronClipboardFileNames,
  saveFileViaElectron,
  saveFilesBulkViaElectron,
  setElectronCloudDriveMode,
  subscribeToUpdateDownloadProgress,
} from '../../src/utils/electronDesktop';

type ElectronAPI = NonNullable<Window['electronAPI']>;

/** Install a desktop bridge with sensible defaults, overridable per test. */
function installElectron(overrides: Partial<ElectronAPI> = {}) {
  const api = {
    platform: 'win32',
    clipboard: {
      peekFileNames: vi.fn(async () => ({ names: ['a.txt'] })),
      readFiles: vi.fn(async () => ({ files: [] })),
      writeFiles: vi.fn(async () => ({ ok: true })),
      writeFilesFromData: vi.fn(async () => ({ ok: true })),
      writeFilesFromServer: vi.fn(async () => ({ ok: true })),
    },
    files: {
      editWithDesktop: vi.fn(async () => ({ ok: true })),
      saveFile: vi.fn(async () => ({ ok: true })),
      saveFilesBulk: vi.fn(async () => ({ ok: true })),
    },
    app: {
      getVersion: vi.fn(async () => ({ version: '2.0.23' })),
      downloadAndInstallUpdate: vi.fn(async () => ({ ok: true })),
      onUpdateDownloadProgress: vi.fn(() => () => {}),
    },
    cloudDrive: {
      start: vi.fn(async () => ({ ok: true, mountPoint: 'T:' })),
      stop: vi.fn(async () => ({ ok: true })),
      status: vi.fn(async () => ({ running: true, mountPoint: 'T:' })),
      getMode: vi.fn(async () => ({ mode: 'full' as const })),
      setMode: vi.fn(async () => ({ ok: true, mode: 'saveOnly' as const })),
    },
    ...overrides,
  } as unknown as ElectronAPI;

  window.electronAPI = api;
  return api;
}

beforeEach(() => {
  delete window.electronAPI;
});

afterEach(() => {
  delete window.electronAPI;
});

describe('isElectron', () => {
  it('is true only for the Windows desktop client', () => {
    installElectron();
    expect(isElectron()).toBe(true);
  });

  it('is false in a plain browser', () => {
    expect(isElectron()).toBe(false);
  });

  it('is false on a non-Windows platform', () => {
    installElectron({ platform: 'darwin' } as Partial<ElectronAPI>);
    expect(isElectron()).toBe(false);
  });

  it('is false when the clipboard bridge is missing', () => {
    window.electronAPI = { platform: 'win32' } as ElectronAPI;
    expect(isElectron()).toBe(false);
  });
});

describe('capability probes', () => {
  it('report true when the matching bridge is present', () => {
    installElectron();
    expect(hasElectronCloudDrive()).toBe(true);
    expect(hasElectronClipboard()).toBe(true);
    expect(hasElectronOpenOnDesktop()).toBe(true);
  });

  it('report false in a browser', () => {
    expect(hasElectronCloudDrive()).toBe(false);
    expect(hasElectronClipboard()).toBe(false);
    expect(hasElectronOpenOnDesktop()).toBe(false);
  });

  it('report false when only part of the clipboard bridge exists', () => {
    installElectron({ clipboard: { readFiles: vi.fn() } } as unknown as Partial<ElectronAPI>);
    expect(hasElectronClipboard()).toBe(false);
  });
});

describe('cloud drive mode', () => {
  it('reads the current mode', async () => {
    installElectron();
    expect(await getElectronCloudDriveMode()).toBe('full');
  });

  it('normalises an unexpected mode to "full"', async () => {
    const api = installElectron();
    api.cloudDrive!.getMode = vi.fn(async () => ({ mode: 'nonsense' as never }));
    expect(await getElectronCloudDriveMode()).toBe('full');
  });

  it('returns "full" outside the desktop app', async () => {
    expect(await getElectronCloudDriveMode()).toBe('full');
  });

  it('returns "full" when the bridge call throws', async () => {
    const api = installElectron();
    api.cloudDrive!.getMode = vi.fn(async () => {
      throw new Error('ipc failed');
    });
    expect(await getElectronCloudDriveMode()).toBe('full');
  });

  it('forwards a mode change to the bridge', async () => {
    const api = installElectron();
    expect(await setElectronCloudDriveMode('saveOnly')).toMatchObject({ ok: true });
    expect(api.cloudDrive!.setMode).toHaveBeenCalledWith('saveOnly');
  });

  it('reports "Not available" outside the desktop app', async () => {
    expect(await setElectronCloudDriveMode('saveOnly')).toEqual({ ok: false, error: 'Not available' });
  });

  it('surfaces a bridge failure as an error result rather than throwing', async () => {
    const api = installElectron();
    api.cloudDrive!.setMode = vi.fn(async () => {
      throw new Error('mount busy');
    });
    expect(await setElectronCloudDriveMode('saveOnly')).toEqual({ ok: false, error: 'mount busy' });
  });
});

describe('getElectronAppVersion', () => {
  it('returns the packaged version', async () => {
    installElectron();
    expect(await getElectronAppVersion()).toBe('2.0.23');
  });

  it('returns null in a browser', async () => {
    expect(await getElectronAppVersion()).toBeNull();
  });

  it('returns null for an empty or missing version', async () => {
    const api = installElectron();
    api.app!.getVersion = vi.fn(async () => ({ version: '' }));
    expect(await getElectronAppVersion()).toBeNull();
  });

  it('returns null when the bridge throws', async () => {
    const api = installElectron();
    api.app!.getVersion = vi.fn(async () => {
      throw new Error('ipc failed');
    });
    expect(await getElectronAppVersion()).toBeNull();
  });
});

describe('subscribeToUpdateDownloadProgress', () => {
  it('returns the bridge unsubscribe function', () => {
    const unsubscribe = vi.fn();
    const api = installElectron();
    api.app!.onUpdateDownloadProgress = vi.fn(() => unsubscribe);

    expect(subscribeToUpdateDownloadProgress(vi.fn())).toBe(unsubscribe);
  });

  it('returns a harmless no-op in a browser', () => {
    const unsubscribe = subscribeToUpdateDownloadProgress(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('base64ToFile', () => {
  it('decodes base64 into a File with the given name and type', () => {
    const file = base64ToFile(btoa('hello'), 'greeting.txt', 'text/plain');
    expect(file.name).toBe('greeting.txt');
    expect(file.type).toBe('text/plain');
    expect(file.size).toBe(5);
  });

  it('round-trips binary bytes without corruption', async () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 254]);
    const base64 = btoa(String.fromCharCode(...bytes));
    const file = base64ToFile(base64, 'b.bin', 'application/octet-stream');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it('produces an empty file for empty input', () => {
    expect(base64ToFile('', 'e.bin', 'application/octet-stream').size).toBe(0);
  });
});

describe('clipboard bridge', () => {
  it('peeks clipboard filenames', async () => {
    installElectron();
    expect(await peekElectronClipboardFileNames()).toEqual(['a.txt']);
  });

  it('returns an empty list in a browser', async () => {
    expect(await peekElectronClipboardFileNames()).toEqual([]);
  });

  it('returns an empty list when the peek throws', async () => {
    const api = installElectron();
    api.clipboard.peekFileNames = vi.fn(async () => {
      throw new Error('clipboard locked');
    });
    expect(await peekElectronClipboardFileNames()).toEqual([]);
  });

  it('returns an empty list when the bridge sends a non-array', async () => {
    const api = installElectron();
    api.clipboard.peekFileNames = vi.fn(async () => ({ names: null as never }));
    expect(await peekElectronClipboardFileNames()).toEqual([]);
  });

  it('converts clipboard payloads into File objects', async () => {
    const api = installElectron();
    api.clipboard.readFiles = vi.fn(async () => ({
      files: [{ name: 'a.txt', mime: 'text/plain', data: btoa('hi') }],
    }));

    const files = await getFilesFromElectronClipboard();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('a.txt');
  });

  it('returns an empty list when the clipboard holds no files', async () => {
    installElectron();
    expect(await getFilesFromElectronClipboard()).toEqual([]);
  });

  it('sends items to the OS clipboard along with the page origin', async () => {
    const api = installElectron();
    const items = [{ id: 'f1', name: 'a.txt' }];

    expect(await copyFilesToPcClipboard(items)).toMatchObject({ ok: true });
    expect(api.clipboard.writeFilesFromServer).toHaveBeenCalledWith({ origin: window.location.origin, items });
  });

  it('refuses an empty selection', async () => {
    installElectron();
    expect(await copyFilesToPcClipboard([])).toEqual({ ok: false, error: 'Not available' });
  });

  it('refuses in a browser', async () => {
    expect(await copyFilesToPcClipboard([{ id: 'f1', name: 'a.txt' }])).toEqual({ ok: false, error: 'Not available' });
  });

  it('caps "Copy to computer" at 200 MB', () => {
    expect(MAX_COPY_TO_PC_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('editFileWithDesktopElectron', () => {
  it('asks the bridge to open the file, passing the origin', async () => {
    const api = installElectron();
    expect(await editFileWithDesktopElectron({ id: 'f1', name: 'a.docx' })).toEqual({ ok: true });
    expect(api.files!.editWithDesktop).toHaveBeenCalledWith({
      origin: window.location.origin,
      item: { id: 'f1', name: 'a.docx' },
    });
  });

  it('explains that desktop editing needs the Windows app', async () => {
    const result = await editFileWithDesktopElectron({ id: 'f1', name: 'a.docx' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only available in the Windows app/i);
  });

  it('surfaces the bridge error message', async () => {
    const api = installElectron();
    api.files!.editWithDesktop = vi.fn(async () => ({ ok: false, error: 'No handler for .docx' }));
    expect(await editFileWithDesktopElectron({ id: 'f1', name: 'a.docx' })).toEqual({
      ok: false,
      error: 'No handler for .docx',
    });
  });

  it('supplies a fallback message when the bridge fails silently', async () => {
    const api = installElectron();
    api.files!.editWithDesktop = vi.fn(async () => ({ ok: false }));
    expect((await editFileWithDesktopElectron({ id: 'f1', name: 'a.docx' })).error).toBe(
      'Failed to edit file on desktop.'
    );
  });

  it('turns a thrown error into a result rather than propagating it', async () => {
    const api = installElectron();
    api.files!.editWithDesktop = vi.fn(async () => {
      throw new Error('ipc failed');
    });
    expect(await editFileWithDesktopElectron({ id: 'f1', name: 'a.docx' })).toEqual({ ok: false, error: 'ipc failed' });
  });
});

describe('save dialogs', () => {
  it('saves a single file through the bridge', async () => {
    const api = installElectron();
    expect(await saveFileViaElectron({ fileId: 'f1', suggestedFileName: 'a.txt' })).toMatchObject({ ok: true });
    expect(api.files!.saveFile).toHaveBeenCalledWith({
      origin: window.location.origin,
      fileId: 'f1',
      suggestedFileName: 'a.txt',
    });
  });

  it('reports a cancelled save distinctly from a failure', async () => {
    const api = installElectron();
    api.files!.saveFile = vi.fn(async () => ({ ok: false, canceled: true }));
    expect(await saveFileViaElectron({ fileId: 'f1', suggestedFileName: 'a.txt' })).toMatchObject({ canceled: true });
  });

  it('saves a bulk selection through the bridge', async () => {
    const api = installElectron();
    expect(await saveFilesBulkViaElectron(['f1', 'f2'])).toMatchObject({ ok: true });
    expect(api.files!.saveFilesBulk).toHaveBeenCalledWith({ origin: window.location.origin, ids: ['f1', 'f2'] });
  });

  it('reports "Not available" in a browser', async () => {
    expect(await saveFileViaElectron({ fileId: 'f1', suggestedFileName: 'a.txt' })).toEqual({
      ok: false,
      error: 'Not available',
    });
    expect(await saveFilesBulkViaElectron(['f1'])).toEqual({ ok: false, error: 'Not available' });
  });
});
