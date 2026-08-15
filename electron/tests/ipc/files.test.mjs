import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import electron, { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot, redirectTmpdir } from '../helpers/tempDirs.cjs';
import { usePlatform } from '../helpers/platform.cjs';

const { BrowserWindow } = electron;

// Captured before any test installs a fake clock.
const realSetTimeout = globalThis.setTimeout;

let files;
let tmpRoot;

/** A window plus the IPC event shape a renderer call arrives with. */
function windowEvent() {
  const win = new BrowserWindow();
  return { win, event: { sender: win.webContents } };
}

beforeEach(() => {
  usePlatform('win32');
  tmpRoot = redirectTmpdir(vi);
  useBuildConfig({ serverUrl: SERVER_URL });
  files = freshRequire('src/main/ipc/files.cjs');
  files.registerEditWithDesktopHandler();
  files.registerSaveFileHandlers();
});

describe('handler registration', () => {
  it('registers the three file channels the preload bridge exposes', () => {
    expect(__mock.handlerChannels().sort()).toEqual(['files:editWithDesktop', 'files:saveFile', 'files:saveFilesBulk']);
  });
});

describe('files:saveFile', () => {
  it('downloads the file to the path the user picked', async () => {
    const { event } = windowEvent();
    const target = path.join(createTempRoot(), 'saved.pdf');
    __mock.setSaveDialogResult({ canceled: false, filePath: target });
    __mock.route('/download', { statusCode: 200, body: 'PDFDATA' });

    const result = await __mock.invoke(
      'files:saveFile',
      { origin: SERVER_URL, fileId: '7', suggestedFileName: 'report.pdf' },
      event
    );

    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('PDFDATA');
    expect(__mock.lastRequest().url).toBe(`${SERVER_URL}/api/files/7/download`);
  });

  it('offers a sanitised default filename in the save dialog', async () => {
    const { event } = windowEvent();
    __mock.setSaveDialogResult({ canceled: true });

    await __mock.invoke(
      'files:saveFile',
      { origin: SERVER_URL, fileId: '7', suggestedFileName: 'in/valid:name?.pdf' },
      event
    );

    expect(__mock.state.saveDialogCalls[0].options.defaultPath).toBe('in_valid_name_.pdf');
  });

  it('falls back to "download" when no filename was suggested', async () => {
    const { event } = windowEvent();
    __mock.setSaveDialogResult({ canceled: true });

    await __mock.invoke('files:saveFile', { origin: SERVER_URL, fileId: '7' }, event);

    expect(__mock.state.saveDialogCalls[0].options.defaultPath).toBe('download');
  });

  it('reports cancellation distinctly from an error', async () => {
    const { event } = windowEvent();
    __mock.setSaveDialogResult({ canceled: true, filePath: undefined });

    await expect(__mock.invoke('files:saveFile', { origin: SERVER_URL, fileId: '7' }, event)).resolves.toEqual({
      ok: false,
      canceled: true,
    });
  });

  it('rejects an origin that is not the configured server', async () => {
    const { event } = windowEvent();

    const result = await __mock.invoke('files:saveFile', { origin: 'https://evil.example.com', fileId: '7' }, event);

    expect(result).toEqual({ ok: false, error: 'Invalid payload' });
    expect(__mock.state.saveDialogCalls).toHaveLength(0);
  });

  it('rejects a payload with no file id', async () => {
    const { event } = windowEvent();
    await expect(__mock.invoke('files:saveFile', { origin: SERVER_URL }, event)).resolves.toEqual({
      ok: false,
      error: 'Invalid payload',
    });
  });

  it('rejects a call that has no window behind it', async () => {
    await expect(__mock.invoke('files:saveFile', { origin: SERVER_URL, fileId: '7' }, { sender: {} })).resolves.toEqual(
      { ok: false, error: 'No window' }
    );
  });

  it('surfaces a download failure to the renderer', async () => {
    const { event } = windowEvent();
    __mock.setSaveDialogResult({ canceled: false, filePath: path.join(createTempRoot(), 'saved.pdf') });
    __mock.route('/download', { statusCode: 403, body: 'forbidden' });

    const result = await __mock.invoke('files:saveFile', { origin: SERVER_URL, fileId: '7' }, event);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
  });
});

describe('files:saveFilesBulk', () => {
  it('posts the selected ids and saves the returned archive', async () => {
    const { event } = windowEvent();
    const target = path.join(createTempRoot(), 'bundle.zip');
    __mock.setSaveDialogResult({ canceled: false, filePath: target });
    __mock.route('/download/bulk', { statusCode: 200, body: 'ZIP' });

    const result = await __mock.invoke('files:saveFilesBulk', { origin: SERVER_URL, ids: ['1', '2'] }, event);

    expect(result).toEqual({ ok: true });
    expect(JSON.parse(__mock.lastRequest().bodyText())).toEqual({ ids: ['1', '2'] });
    expect(fs.readFileSync(target, 'utf8')).toBe('ZIP');
  });

  it('drops null ids before deciding whether there is anything to download', async () => {
    const { event } = windowEvent();
    __mock.setSaveDialogResult({ canceled: false, filePath: path.join(createTempRoot(), 'b.zip') });
    __mock.route('/download/bulk', { statusCode: 200, body: 'ZIP' });

    await __mock.invoke('files:saveFilesBulk', { origin: SERVER_URL, ids: ['1', null, undefined, '2'] }, event);

    expect(JSON.parse(__mock.lastRequest().bodyText())).toEqual({ ids: ['1', '2'] });
  });

  it('suggests a timestamped zip name', async () => {
    const { event } = windowEvent();
    __mock.setSaveDialogResult({ canceled: true });

    await __mock.invoke('files:saveFilesBulk', { origin: SERVER_URL, ids: ['1'] }, event);

    expect(__mock.state.saveDialogCalls[0].options.defaultPath).toMatch(/^download_\d+\.zip$/);
  });

  it('refuses an empty selection', async () => {
    const { event } = windowEvent();
    await expect(__mock.invoke('files:saveFilesBulk', { origin: SERVER_URL, ids: [] }, event)).resolves.toEqual({
      ok: false,
      error: 'Invalid payload',
    });
  });

  it('refuses ids that did not arrive as an array', async () => {
    const { event } = windowEvent();
    await expect(__mock.invoke('files:saveFilesBulk', { origin: SERVER_URL, ids: 'all' }, event)).resolves.toEqual({
      ok: false,
      error: 'Invalid payload',
    });
  });

  it('rejects an untrusted origin', async () => {
    const { event } = windowEvent();
    await expect(
      __mock.invoke('files:saveFilesBulk', { origin: 'https://evil.example.com', ids: ['1'] }, event)
    ).resolves.toEqual({ ok: false, error: 'Invalid payload' });
  });

  it('reports cancellation', async () => {
    const { event } = windowEvent();
    __mock.setSaveDialogResult({ canceled: true });
    await expect(__mock.invoke('files:saveFilesBulk', { origin: SERVER_URL, ids: ['1'] }, event)).resolves.toEqual({
      ok: false,
      canceled: true,
    });
  });
});

describe('files:editWithDesktop', () => {
  /** fs.watch is replaced so watcher callbacks can be fired deterministically. */
  let watchers;

  function fakeWatch() {
    watchers = [];
    vi.spyOn(fs, 'watch').mockImplementation((target, listener) => {
      const handle = new EventEmitter();
      handle.close = vi.fn();
      handle.target = target;
      handle.listener = listener;
      watchers.push(handle);
      return handle;
    });
    return watchers;
  }

  /** The directory watcher is the second one registered for a session. */
  const fileWatcher = () => watchers[0];
  const dirWatcher = () => watchers[1];

  function editDirOf() {
    return dirWatcher().target;
  }

  beforeEach(() => {
    fakeWatch();
    __mock.route('/info', { statusCode: 200, body: JSON.stringify({ size: 100, modified: '2026-01-01T00:00:00Z' }) });
    __mock.route('/download', { statusCode: 200, body: 'ORIGINAL' });
  });

  const item = { id: '7', name: 'report.docx' };

  it('downloads the file into a temp edit directory and opens it', async () => {
    const { event } = windowEvent();

    const result = await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

    expect(result).toEqual({ ok: true });
    const opened = __mock.state.openPathCalls[0];
    expect(path.basename(opened)).toBe('report.docx');
    expect(path.basename(path.dirname(opened)).startsWith('tma-cloud-edit-')).toBe(true);
    expect(fs.readFileSync(opened, 'utf8')).toBe('ORIGINAL');
  });

  it('sanitises the filename before writing it to disk', async () => {
    const { event } = windowEvent();
    await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item: { id: '7', name: 'a/b:c.docx' } }, event);
    expect(path.basename(__mock.state.openPathCalls[0])).toBe('a_b_c.docx');
  });

  it('is refused outside Windows', async () => {
    usePlatform('linux');
    const { event } = windowEvent();
    await expect(__mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event)).resolves.toEqual({
      ok: false,
      error: 'Desktop editing is only supported on Windows',
    });
  });

  it('rejects an untrusted origin before touching the network', async () => {
    const { event } = windowEvent();
    const result = await __mock.invoke('files:editWithDesktop', { origin: 'https://evil.example.com', item }, event);
    expect(result).toEqual({ ok: false, error: 'Invalid payload' });
    expect(__mock.state.openPathCalls).toHaveLength(0);
  });

  it('rejects an item without an id or a name', async () => {
    const { event } = windowEvent();
    await expect(
      __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item: { id: '7' } }, event)
    ).resolves.toEqual({ ok: false, error: 'Invalid payload' });
    await expect(
      __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item: { name: 'a.docx' } }, event)
    ).resolves.toEqual({ ok: false, error: 'Invalid payload' });
  });

  it('reports a download failure without opening anything', async () => {
    __mock.state.netRoutes = [];
    __mock.route('/info', { statusCode: 200, body: '{}' });
    __mock.route('/download', { statusCode: 404, body: 'gone' });
    const { event } = windowEvent();

    const result = await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
    expect(__mock.state.openPathCalls).toHaveLength(0);
  });

  it('reports the reason when Windows cannot open the file', async () => {
    __mock.setOpenPathResult('No application is associated with this file');
    const { event } = windowEvent();

    await expect(__mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event)).resolves.toEqual({
      ok: false,
      error: 'No application is associated with this file',
    });
  });

  it('still opens the file when the metadata lookup fails', async () => {
    __mock.state.netRoutes = [];
    __mock.routeError('/info', new Error('offline'));
    __mock.route('/download', { statusCode: 200, body: 'ORIGINAL' });
    const { event } = windowEvent();

    await expect(__mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event)).resolves.toEqual({
      ok: true,
    });
  });

  it('keeps the edit directory out of temp cleanup while the session is open', async () => {
    const { event } = windowEvent();
    await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

    const active = files.getActiveEditDirs();

    expect(active.has(editDirOf())).toBe(true);
  });

  describe('caching large downloads', () => {
    const largeInfo = { size: 8 * 1024 * 1024, modified: '2026-01-01T00:00:00Z' };

    function routeLarge(info = largeInfo) {
      __mock.state.netRoutes = [];
      __mock.route('/info', { statusCode: 200, body: JSON.stringify(info) });
      __mock.route('/download', { statusCode: 200, body: 'ORIGINAL' });
    }

    function downloadCount() {
      return __mock.requests().filter(r => r.url.endsWith('/download')).length;
    }

    it('reuses the cached copy when size and modified time are unchanged', async () => {
      routeLarge();
      const { event } = windowEvent();

      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);
      const first = __mock.state.openPathCalls[0];
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      expect(downloadCount()).toBe(1);
      expect(__mock.state.openPathCalls[1]).toBe(first);
    });

    it('downloads again when the server copy was modified since', async () => {
      routeLarge();
      const { event } = windowEvent();
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      routeLarge({ size: largeInfo.size, modified: '2026-02-02T00:00:00Z' });
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      expect(downloadCount()).toBe(2);
    });

    it('downloads again when the size changed', async () => {
      routeLarge();
      const { event } = windowEvent();
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      routeLarge({ size: largeInfo.size + 1, modified: largeInfo.modified });
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      expect(downloadCount()).toBe(2);
    });

    it('downloads again when the cached file was deleted from disk', async () => {
      routeLarge();
      const { event } = windowEvent();
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);
      fs.rmSync(__mock.state.openPathCalls[0]);

      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      expect(downloadCount()).toBe(2);
    });

    it('does not cache small files, which are cheap to fetch again', async () => {
      const { event } = windowEvent(); // default route reports a 100 byte file
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      expect(downloadCount()).toBe(2);
    });

    it('keeps a cached directory out of temp cleanup after the session ends', async () => {
      routeLarge();
      const { event } = windowEvent();
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);
      const cachedDir = path.dirname(__mock.state.openPathCalls[0]);

      expect(files.getActiveEditDirs().has(cachedDir)).toBe(true);
    });
  });

  describe('saving from the desktop editor', () => {
    beforeEach(() => {
      // setImmediate stays real so the suite can drive the module's own
      // promises (hashing, streaming uploads) while still controlling the
      // debounce, throttle and dedupe windows, which are all clock-based.
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      return () => vi.useRealTimers();
    });

    /**
     * Yield to the event loop until `predicate` holds, or fail the test.
     * Uses the real timer captured before the fake clock was installed: a tight
     * setImmediate loop starves the file reads the upload path depends on.
     */
    async function waitFor(predicate, label) {
      // Counted rather than clock-based: Date.now() is faked here, and each
      // iteration sleeps on the real timer, so this waits at least 3 seconds
      // of wall time on any machine.
      for (let i = 0; i < 1500; i += 1) {
        if (predicate()) return;
        await new Promise(resolve => realSetTimeout(resolve, 2));
      }
      throw new Error(`timed out waiting for ${label}`);
    }

    /** Give pending work a chance to run, for negative assertions. */
    async function settle() {
      for (let i = 0; i < 20; i += 1) {
        await new Promise(resolve => realSetTimeout(resolve, 1));
      }
    }

    async function startSession() {
      const { win, event } = windowEvent();
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);
      __mock.route('/replace', { statusCode: 200, body: '' });
      __mock.route('/derived', { statusCode: 200, body: '' });
      return { win, editDir: editDirOf(), filePath: __mock.state.openPathCalls[0] };
    }

    function replaceRequests() {
      return __mock.requests().filter(r => r.url.endsWith('/replace'));
    }

    function derivedRequests() {
      return __mock.requests().filter(r => r.url.endsWith('/derived'));
    }

    /** Wait until the nth replace upload has been fully sent and answered. */
    async function waitForUpload(count) {
      await waitFor(
        () => replaceRequests().length === count && replaceRequests()[count - 1]._ended,
        `replace upload ${count}`
      );
      await settle();
    }

    it('uploads the edited file back over the original when it changes', async () => {
      const { filePath } = await startSession();
      fs.writeFileSync(filePath, 'EDITED');

      fileWatcher().listener('change');
      await waitForUpload(1);

      expect(replaceRequests()[0].url).toBe(`${SERVER_URL}/api/files/7/replace`);
      expect(replaceRequests()[0].bodyText()).toContain('EDITED');
    });

    it('does not upload when the contents are unchanged', async () => {
      await startSession();

      fileWatcher().listener('change');
      await settle();

      expect(replaceRequests()).toHaveLength(0);
    });

    it('throttles a burst of save events into a single upload', async () => {
      const { filePath } = await startSession();

      fs.writeFileSync(filePath, 'EDITED 1');
      fileWatcher().listener('change');
      await waitForUpload(1);

      fs.writeFileSync(filePath, 'EDITED 2');
      fileWatcher().listener('change');
      await settle();

      expect(replaceRequests()).toHaveLength(1);
    });

    it('uploads again once the throttle window has passed', async () => {
      const { filePath } = await startSession();

      fs.writeFileSync(filePath, 'EDITED 1');
      fileWatcher().listener('change');
      await waitForUpload(1);

      vi.advanceTimersByTime(6000);
      fs.writeFileSync(filePath, 'EDITED 2');
      fileWatcher().listener('change');
      await waitForUpload(2);
    });

    it('keeps the session alive when an upload fails', async () => {
      const { filePath } = await startSession();
      __mock.state.netRoutes = __mock.state.netRoutes.filter(r => r.match !== '/replace');
      __mock.route('/replace', { statusCode: 500, body: 'boom' });

      fs.writeFileSync(filePath, 'EDITED');
      fileWatcher().listener('change');
      await waitForUpload(1);

      // A failed upload must not record the new hash, so the next save retries.
      vi.advanceTimersByTime(6000);
      fileWatcher().listener('change');
      await waitForUpload(2);
    });

    it('uploads an exported PDF as a new file in the same folder', async () => {
      const { win, editDir } = await startSession();
      fs.writeFileSync(path.join(editDir, 'report.pdf'), 'PDFDATA');

      dirWatcher().listener('rename', 'report.pdf');
      vi.advanceTimersByTime(1600);
      await waitFor(() => derivedRequests().length === 1, 'the export to be uploaded');
      await waitFor(() => win.webContents.sent.length === 2, 'the completion notice');

      expect(derivedRequests()[0].url).toBe(`${SERVER_URL}/api/files/7/derived`);
      expect(win.webContents.sent.map(s => s.payload.state)).toEqual(['started', 'completed']);
    });

    it('tells the renderer the exported name and size so it can show a toast', async () => {
      const { win, editDir } = await startSession();
      fs.writeFileSync(path.join(editDir, 'report.pdf'), 'PDFDATA');

      dirWatcher().listener('rename', 'report.pdf');
      vi.advanceTimersByTime(1600);
      await waitFor(() => win.webContents.sent.length > 0, 'the upload notice');

      expect(win.webContents.sent[0]).toEqual({
        channel: 'files:derivedUploadStatus',
        payload: { state: 'started', fileName: 'report.pdf', size: 7, originalId: '7' },
      });
    });

    it('reports a failed derived upload to the renderer', async () => {
      const { win, editDir } = await startSession();
      __mock.state.netRoutes = __mock.state.netRoutes.filter(r => r.match !== '/derived');
      __mock.route('/derived', { statusCode: 507, body: 'quota exceeded' });
      fs.writeFileSync(path.join(editDir, 'report.pdf'), 'PDFDATA');

      dirWatcher().listener('rename', 'report.pdf');
      vi.advanceTimersByTime(1600);
      await waitFor(() => win.webContents.sent.some(s => s.payload.state === 'error'), 'the failure notice');

      const last = win.webContents.sent[win.webContents.sent.length - 1];
      expect(last.payload.state).toBe('error');
      expect(last.payload.error).toContain('507');
    });

    it('debounces repeated events for one export into a single upload', async () => {
      const { editDir } = await startSession();
      fs.writeFileSync(path.join(editDir, 'report.pdf'), 'PDFDATA');

      dirWatcher().listener('change', 'report.pdf');
      vi.advanceTimersByTime(500);
      dirWatcher().listener('change', 'report.pdf');
      vi.advanceTimersByTime(1600);
      await waitFor(() => derivedRequests().length === 1, 'the single upload');
      await settle();

      expect(derivedRequests()).toHaveLength(1);
    });

    it('does not upload the same export twice within the dedupe window', async () => {
      const { editDir } = await startSession();
      fs.writeFileSync(path.join(editDir, 'report.pdf'), 'PDFDATA');

      dirWatcher().listener('change', 'report.pdf');
      vi.advanceTimersByTime(1600);
      await waitFor(() => derivedRequests().length === 1, 'the first upload');

      dirWatcher().listener('change', 'report.pdf');
      vi.advanceTimersByTime(1600);
      await settle();

      expect(derivedRequests()).toHaveLength(1);
    });

    it('ignores the file being edited, which the replace path already handles', async () => {
      const { editDir } = await startSession();

      dirWatcher().listener('change', path.basename(path.join(editDir, 'report.docx')));
      vi.advanceTimersByTime(2000);
      await settle();

      expect(derivedRequests()).toHaveLength(0);
    });

    it('ignores Office lock files', async () => {
      const { editDir } = await startSession();
      fs.writeFileSync(path.join(editDir, '~$report.docx'), 'LOCK');

      dirWatcher().listener('rename', '~$report.docx');
      vi.advanceTimersByTime(2000);
      await settle();

      expect(derivedRequests()).toHaveLength(0);
    });

    it('ignores file types that are not export formats', async () => {
      const { editDir } = await startSession();
      fs.writeFileSync(path.join(editDir, 'scratch.tmp'), 'TMP');

      dirWatcher().listener('rename', 'scratch.tmp');
      vi.advanceTimersByTime(2000);
      await settle();

      expect(derivedRequests()).toHaveLength(0);
    });

    it('ignores an event with no filename attached', async () => {
      await startSession();
      dirWatcher().listener('rename', null);
      vi.advanceTimersByTime(2000);
      await settle();
      expect(derivedRequests()).toHaveLength(0);
    });
  });

  describe('watcher lifecycle', () => {
    it('closes the previous watchers when the same file is opened again', async () => {
      const { event } = windowEvent();
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);
      const [firstFile, firstDir] = watchers;

      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      expect(firstFile.close).toHaveBeenCalled();
      expect(firstDir.close).toHaveBeenCalled();
    });

    it('closes every watcher when the app quits', async () => {
      const { event } = windowEvent();
      await __mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event);

      __mock.emitAppEvent('before-quit');

      for (const handle of watchers) expect(handle.close).toHaveBeenCalled();
      expect(files.getActiveEditDirs().size).toBe(0);
    });

    it('still opens the file when the OS refuses to watch it', async () => {
      fs.watch.mockImplementation(() => {
        throw new Error('EMFILE: too many open files');
      });
      const { event } = windowEvent();

      await expect(__mock.invoke('files:editWithDesktop', { origin: SERVER_URL, item }, event)).resolves.toEqual({
        ok: true,
      });
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(tmpRoot).toBeTruthy();
});
