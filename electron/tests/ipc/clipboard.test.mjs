import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import electron, { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot, redirectTmpdir, writeFile } from '../helpers/tempDirs.cjs';
import { fakeSpawn } from '../helpers/childProcess.cjs';
import { usePlatform } from '../helpers/platform.cjs';

const PASTE_DIR_PREFIX = 'tma-cloud-paste-';
const { BrowserWindow } = electron;

let tmpRoot;

/** A window plus the IPC event shape a renderer call arrives with. */
function windowEvent() {
  const win = new BrowserWindow();
  return { win, event: { sender: win.webContents } };
}

/** The preflight every upload runs: per-file maximum, then the storage quota. */
function routeUploadPreflight({ maxBytes = 10 * 1024 * 1024 * 1024, quota } = {}) {
  __mock.route('/api/user/max-upload-size-config', { statusCode: 200, body: JSON.stringify({ maxBytes }) });
  __mock.route(
    '/api/files/upload/check',
    quota || { statusCode: 200, body: JSON.stringify({ allowed: true }) },
    'POST'
  );
}

/** The upload cards a paste opened, in the order the renderer received them. */
function uploadStatuses(win) {
  return win.webContents.sent.filter(s => s.channel === 'clipboard:uploadStatus').map(s => s.payload);
}

/**
 * Answer the two PowerShell scripts the clipboard code runs: the file-drop-list
 * one-liner and the OLE extraction script passed through the environment.
 */
function fakePowerShell({ dropList = '', ole = '{}', dropListFails = false, oleFails = false } = {}) {
  return fakeSpawn(vi, child => {
    const isOle = child.args.includes('$env:OLE_SCRIPT | iex');
    setTimeout(() => {
      if (isOle) {
        if (oleFails) {
          child.emitStderr('compile failed');
          child.exit(1);
          return;
        }
        child.emitStdout(ole);
      } else {
        if (dropListFails) {
          child.emitStderr('clipboard busy');
          child.exit(1);
          return;
        }
        child.emitStdout(dropList);
      }
      child.exit(0);
    }, 0);
  });
}

/** The single paste directory the clipboard handlers created, if any. */
function pasteDir() {
  const names = fs.readdirSync(tmpRoot).filter(n => n.startsWith(PASTE_DIR_PREFIX));
  return names.length ? path.join(tmpRoot, names[0]) : null;
}

beforeEach(() => {
  usePlatform('win32');
  tmpRoot = redirectTmpdir(vi);
  useBuildConfig({ serverUrl: SERVER_URL });
  freshRequire('src/main/ipc/clipboard.cjs').registerClipboardHandlers();
});

describe('handler registration', () => {
  it('registers every clipboard channel the preload bridge exposes', () => {
    expect(__mock.handlerChannels().sort()).toEqual([
      'clipboard:cancelUpload',
      'clipboard:claim',
      'clipboard:peekFileNames',
      'clipboard:readFiles',
      'clipboard:uploadFiles',
      'clipboard:uploadVirtualFiles',
      'clipboard:writeFiles',
      'clipboard:writeFilesFromData',
      'clipboard:writeFilesFromServer',
    ]);
  });
});

describe('clipboard:peekFileNames', () => {
  it('returns just the names, so a freshness check costs no file reads', async () => {
    // Built with path.join so the assertion holds on the Linux CI runner too.
    const dir = createTempRoot();
    const dropList = [path.join(dir, 'a.txt'), path.join(dir, 'b.png')].join('\r\n');
    fakePowerShell({ dropList: `${dropList}\r\n` });

    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({
      names: ['a.txt', 'b.png'],
      external: true,
    });
  });

  it('treats files this app staged for Explorer as its own copy', async () => {
    const dir = path.join(tmpRoot, `${PASTE_DIR_PREFIX}1`);
    fakePowerShell({ dropList: `${path.join(dir, 'a.txt')}\r\n` });

    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: ['a.txt'], external: false });
  });

  it('returns nothing when the clipboard holds no files', async () => {
    fakePowerShell({ dropList: '' });
    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: [], external: false });
  });

  it('returns nothing rather than failing when PowerShell errors', async () => {
    fakePowerShell({ dropListFails: true });
    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: [], external: false });
  });

  it('returns nothing outside Windows', async () => {
    usePlatform('darwin');
    const spawned = fakePowerShell({ dropList: 'C:\\a.txt' });
    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: [], external: false });
    expect(spawned).toHaveLength(0);
  });
});

describe('clipboard:readFiles', () => {
  it('does not materialise Explorer files through the legacy base64 endpoint', async () => {
    const dir = createTempRoot();
    const file = writeFile(dir, 'note.txt', 'hello');
    fakePowerShell({ dropList: `${file}\r\n` });

    const readFile = vi.spyOn(fs.promises, 'readFile');
    await expect(__mock.invoke('clipboard:readFiles')).resolves.toEqual({ files: [] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('falls back to the OLE clipboard for Outlook attachments and screenshots', async () => {
    const payload = JSON.stringify({ 'shot.png': Buffer.from('PNG').toString('base64') });
    fakePowerShell({ dropList: '', ole: payload });

    const { files } = await __mock.invoke('clipboard:readFiles');

    expect(files).toEqual([{ name: 'shot.png', mime: 'image/png', data: Buffer.from('PNG').toString('base64') }]);
  });

  it('does not materialise clipboard text paths through renderer IPC', async () => {
    fakePowerShell({ dropList: '', ole: '{}' });
    // Only drive-letter and UNC paths are recognised, so the fixture is a
    // Windows path with the filesystem stubbed — this runs on Linux CI too.
    const copied = 'C:\\Users\\me\\copied.txt';
    __mock.setClipboardText(`"${copied}"`);
    const readFile = vi.spyOn(fs.promises, 'readFile');
    await expect(__mock.invoke('clipboard:readFiles')).resolves.toEqual({ files: [] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('ignores a relative path in clipboard text, which could point anywhere', async () => {
    fakePowerShell({ dropList: '', ole: '{}' });
    __mock.setClipboardText('..\\..\\secrets.txt');
    const stat = vi.spyOn(fs.promises, 'stat');

    await expect(__mock.invoke('clipboard:readFiles')).resolves.toEqual({ files: [] });
    expect(stat).not.toHaveBeenCalled();
  });

  it('ignores clipboard text that is not a set of absolute paths', async () => {
    fakePowerShell({ dropList: '', ole: '{}' });
    __mock.setClipboardText('just some copied prose\nnot a path');

    await expect(__mock.invoke('clipboard:readFiles')).resolves.toEqual({ files: [] });
  });

  it('returns nothing when every source is empty', async () => {
    fakePowerShell({ dropList: '', ole: '{}' });
    __mock.setClipboardText('');
    await expect(__mock.invoke('clipboard:readFiles')).resolves.toEqual({ files: [] });
  });

  it('survives a failure in each PowerShell stage', async () => {
    fakePowerShell({ dropListFails: true, oleFails: true });
    __mock.setClipboardText('');
    await expect(__mock.invoke('clipboard:readFiles')).resolves.toEqual({ files: [] });
  });

  it('returns nothing outside Windows', async () => {
    usePlatform('linux');
    const spawned = fakePowerShell({ dropList: 'C:\\a.txt' });
    await expect(__mock.invoke('clipboard:readFiles')).resolves.toEqual({ files: [] });
    expect(spawned).toHaveLength(0);
  });

  it('assigns a binary type to files it cannot classify', async () => {
    const payload = JSON.stringify({ 'thing.zzzzz': Buffer.from('x').toString('base64') });
    fakePowerShell({ dropList: '', ole: payload });

    const { files } = await __mock.invoke('clipboard:readFiles');

    expect(files[0].mime).toBe('application/octet-stream');
  });
});

describe('direct clipboard uploads', () => {
  it('uploads virtual OLE bytes without creating a plaintext temp file', async () => {
    const encoded = Buffer.from('VIRTUAL-DATA').toString('base64');
    fakePowerShell({ ole: JSON.stringify({ 'attachment.txt': encoded }) });
    routeUploadPreflight();
    __mock.route('/api/files/upload', { statusCode: 201, body: '{}' });

    const result = await __mock.invoke('clipboard:uploadVirtualFiles', {
      origin: SERVER_URL,
      parentId: 'folder-1',
    });

    expect(result).toEqual({ ok: true, names: ['attachment.txt'], failed: [] });
    const request = __mock.requests().find(item => item.url.endsWith('/api/files/upload'));
    expect(request.bodyText()).toContain('VIRTUAL-DATA');
    expect(request.chunkedEncoding).toBe(true);
    expect(pasteDir()).toBeNull();
  });

  it('opens and closes an upload card for each pasted file, with byte progress', async () => {
    const { win, event } = windowEvent();
    const file = writeFile(createTempRoot(), 'pasted.txt', 'CLIPBOARD-BYTES');
    fakePowerShell({ dropList: `${file}\r\n` });
    routeUploadPreflight();
    __mock.route('/api/files/upload', { statusCode: 201, body: '{}' });

    const result = await __mock.invoke('clipboard:uploadFiles', { origin: SERVER_URL, parentId: null }, event);

    expect(result).toEqual({ ok: true, names: ['pasted.txt'], failed: [] });
    const statuses = uploadStatuses(win);
    expect(statuses[0]).toMatchObject({ state: 'started', fileName: 'pasted.txt', fileSize: 15 });
    expect(statuses[1]).toMatchObject({ state: 'completed', id: statuses[0].id });
    expect(statuses[2]).toMatchObject({ state: 'finished', saved: 1, failed: [] });

    // Real bytes, not a simulated percentage: the last event equals the file size.
    const progress = win.webContents.sent.filter(s => s.channel === 'clipboard:uploadProgress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].payload).toMatchObject({ id: statuses[0].id, loaded: 15, total: 15 });
  });

  it('reports a refused file to the upload-issues dialog and still uploads the rest', async () => {
    const { win, event } = windowEvent();
    const dir = createTempRoot();
    const bad = writeFile(dir, 'refused.txt', 'NOPE');
    const good = writeFile(dir, 'fine.txt', 'YES');
    fakePowerShell({ dropList: `${bad}\r\n${good}\r\n` });
    routeUploadPreflight();
    __mock.route(request => request.bodyText().includes('NOPE'), { statusCode: 415, body: 'Unsupported file' });
    __mock.route('/api/files/upload', { statusCode: 201, body: '{}' });

    const result = await __mock.invoke('clipboard:uploadFiles', { origin: SERVER_URL, parentId: null }, event);

    expect(result.ok).toBe(true);
    expect(result.names).toEqual(['fine.txt']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].fileName).toBe('refused.txt');
    const statuses = uploadStatuses(win);
    expect(statuses.some(s => s.state === 'error' && s.fileName === 'refused.txt')).toBe(true);
    expect(statuses[statuses.length - 1]).toMatchObject({ state: 'finished', saved: 1 });
    expect(statuses[statuses.length - 1].failed).toHaveLength(1);
  });

  it('counts a cancelled file as neither saved nor failed, and shows no error card', async () => {
    const { win, event } = windowEvent();
    const file = writeFile(createTempRoot(), 'big.bin', 'x'.repeat(4096));
    fakePowerShell({ dropList: `${file}\r\n` });
    routeUploadPreflight();
    // Consulted once the bytes are on the wire and before any reply: the one
    // deterministic moment to cancel an upload still in flight.
    __mock.route(() => {
      const started = uploadStatuses(win).find(s => s.state === 'started');
      if (started) void __mock.invoke('clipboard:cancelUpload', started.id);
      return false;
    }, {});

    const result = await __mock.invoke('clipboard:uploadFiles', { origin: SERVER_URL, parentId: null }, event);

    expect(result).toEqual({ ok: true, names: [], failed: [] });
    const statuses = uploadStatuses(win);
    // No error card: the renderer already took the row away when the user cancelled.
    expect(statuses.some(s => s.state === 'error')).toBe(false);
    expect(statuses[statuses.length - 1]).toMatchObject({ state: 'finished', saved: 0, failed: [] });
  });

  it('runs the same preflight a browser upload runs, before sending any bytes', async () => {
    const { event } = windowEvent();
    const file = writeFile(createTempRoot(), 'pasted.txt', 'CLIPBOARD-BYTES');
    fakePowerShell({ dropList: `${file}\r\n` });
    routeUploadPreflight();
    __mock.route('/api/files/upload', { statusCode: 201, body: '{}' });

    await __mock.invoke('clipboard:uploadFiles', { origin: SERVER_URL, parentId: null }, event);

    const calls = __mock.requests().map(r => `${r.method} ${r.url.replace(SERVER_URL, '')}`);
    expect(calls).toEqual([
      'GET /api/user/max-upload-size-config',
      'POST /api/files/upload/check',
      'POST /api/files/upload',
    ]);
  });

  it('refuses a file over the configured maximum without uploading it', async () => {
    const { event } = windowEvent();
    const file = writeFile(createTempRoot(), 'huge.bin', 'x'.repeat(4096));
    fakePowerShell({ dropList: `${file}\r\n` });
    routeUploadPreflight({ maxBytes: 1024 });

    const result = await __mock.invoke('clipboard:uploadFiles', { origin: SERVER_URL, parentId: null }, event);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('"huge.bin" is too large. Maximum upload size is 1 KB.');
    expect(__mock.requests().some(r => r.url.endsWith('/api/files/upload'))).toBe(false);
  });

  it("passes the server's own quota message through, rather than a limit of its own", async () => {
    const { event } = windowEvent();
    const file = writeFile(createTempRoot(), 'pasted.txt', 'CLIPBOARD-BYTES');
    fakePowerShell({ dropList: `${file}\r\n` });
    routeUploadPreflight({
      quota: { statusCode: 413, body: JSON.stringify({ message: 'Storage limit reached. Free up 2 GB.' }) },
    });

    const result = await __mock.invoke('clipboard:uploadFiles', { origin: SERVER_URL, parentId: null }, event);

    expect(result).toEqual({ ok: false, error: 'Storage limit reached. Free up 2 GB.' });
    expect(__mock.requests().some(r => r.url.endsWith('/api/files/upload'))).toBe(false);
  });

  it('tears the request down mid-stream, so the server sees the client hang up', async () => {
    const { win, event } = windowEvent();
    // Big enough to stream in several chunks, so the cancel lands between them.
    const file = writeFile(createTempRoot(), 'big.bin', 'x'.repeat(512 * 1024));
    fakePowerShell({ dropList: `${file}\r\n` });
    routeUploadPreflight();
    __mock.route('/api/files/upload', { statusCode: 201, body: '{}' });

    // The first byte-progress event fires from inside the read stream: the same
    // mid-upload moment the user's click lands in.
    const send = win.webContents.send.bind(win.webContents);
    let cancelled = false;
    win.webContents.send = (channel, payload) => {
      send(channel, payload);
      if (channel === 'clipboard:uploadProgress' && !cancelled) {
        cancelled = true;
        __mock.invoke('clipboard:cancelUpload', payload.id);
      }
    };

    const result = await __mock.invoke('clipboard:uploadFiles', { origin: SERVER_URL, parentId: null }, event);

    expect(cancelled).toBe(true);
    expect(result).toEqual({ ok: true, names: [], failed: [] });
    const upload = __mock.requests().find(r => r.url.endsWith('/api/files/upload'));
    // Buffered instead, the abort would cancel a request the server never saw.
    expect(upload.chunkedEncoding).toBe(true);
    // Aborted, not quietly finished: an ended request would have reached the route.
    expect(upload.destroyed).toBe(true);
    expect(upload._ended).toBeFalsy();
    // And nothing kept writing into it afterwards, which Electron throws on.
    expect(upload.writesAfterAbort).toBeUndefined();
  });

  it('reports nothing to cancel for an upload that already settled', async () => {
    expect(__mock.invoke('clipboard:cancelUpload', 'clipboard-0-0')).toEqual({ ok: false });
    expect(__mock.invoke('clipboard:cancelUpload', undefined)).toEqual({ ok: false });
  });
});

describe('clipboard:writeFiles', () => {
  it('puts existing paths on the Windows clipboard', async () => {
    const file = writeFile(createTempRoot(), 'a.txt', 'x');
    const spawned = fakePowerShell();

    await expect(__mock.invoke('clipboard:writeFiles', [file])).resolves.toEqual({ ok: true });
    expect(spawned[0].args.join(' ')).toContain('SetFileDropList');
  });

  it('refuses an empty or non-array selection', async () => {
    fakePowerShell();
    await expect(__mock.invoke('clipboard:writeFiles', [])).resolves.toEqual({ ok: false });
    await expect(__mock.invoke('clipboard:writeFiles', 'C:\\a.txt')).resolves.toEqual({ ok: false });
    await expect(__mock.invoke('clipboard:writeFiles', undefined)).resolves.toEqual({ ok: false });
  });

  it('refuses outside Windows', async () => {
    usePlatform('darwin');
    await expect(__mock.invoke('clipboard:writeFiles', ['C:\\a.txt'])).resolves.toEqual({ ok: false });
  });

  it('reports the failure when the clipboard cannot be set', async () => {
    fakePowerShell({ dropListFails: true });
    const file = writeFile(createTempRoot(), 'a.txt', 'x');

    const result = await __mock.invoke('clipboard:writeFiles', [file]);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('clipboard:writeFilesFromData', () => {
  const fileEntry = (name, text) => ({ name, data: Buffer.from(text).toString('base64') });

  it('materialises the files in a temp folder and copies them to the clipboard', async () => {
    fakePowerShell();

    const result = await __mock.invoke('clipboard:writeFilesFromData', {
      files: [fileEntry('a.txt', 'AAA'), fileEntry('b.txt', 'BBB')],
    });

    expect(result).toEqual({ ok: true });
    expect(fs.readdirSync(pasteDir()).sort()).toEqual(['a.txt', 'b.txt']);
    expect(fs.readFileSync(path.join(pasteDir(), 'a.txt'), 'utf8')).toBe('AAA');
  });

  it('sanitises names so a payload cannot write outside the paste folder', async () => {
    fakePowerShell();

    await __mock.invoke('clipboard:writeFilesFromData', { files: [fileEntry('../../evil.txt', 'X')] });

    expect(fs.readdirSync(pasteDir())).toEqual(['.._.._evil.txt']);
  });

  it('deduplicates repeated names instead of overwriting', async () => {
    fakePowerShell();

    await __mock.invoke('clipboard:writeFilesFromData', {
      files: [fileEntry('a.txt', 'first'), fileEntry('a.txt', 'second')],
    });

    expect(fs.readdirSync(pasteDir()).sort()).toEqual(['a (1).txt', 'a.txt']);
  });

  it('clears earlier paste folders so temp does not grow without bound', async () => {
    fakePowerShell();
    const stale = path.join(tmpRoot, `${PASTE_DIR_PREFIX}old`);
    fs.mkdirSync(stale, { recursive: true });
    // A folder stamped in the current millisecond is skipped by the sweep, so
    // backdate it to the previous paste it stands for.
    const earlier = new Date(Date.now() - 1000);
    fs.utimesSync(stale, earlier, earlier);

    await __mock.invoke('clipboard:writeFilesFromData', { files: [fileEntry('a.txt', 'X')] });

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('skips entries with no name or non-string data', async () => {
    fakePowerShell();

    await __mock.invoke('clipboard:writeFilesFromData', {
      files: [{ data: 'AAA' }, { name: 'b.txt', data: 42 }, fileEntry('c.txt', 'CCC')],
    });

    expect(fs.readdirSync(pasteDir())).toEqual(['c.txt']);
  });

  it('rejects a single file over the per-file limit before allocating it', async () => {
    fakePowerShell();
    const oversized = { name: 'huge.bin', data: 'A'.repeat(300 * 1024 * 1024) };

    const result = await __mock.invoke('clipboard:writeFilesFromData', { files: [oversized] });

    expect(result).toEqual({ ok: false, error: 'File exceeds maximum allowed size' });
  });

  it('rejects a batch whose total exceeds the overall limit', async () => {
    fakePowerShell();
    const chunk = () => ({ name: 'part.bin', data: 'A'.repeat(180 * 1024 * 1024) });

    const result = await __mock.invoke('clipboard:writeFilesFromData', {
      files: [chunk(), chunk(), chunk(), chunk()],
    });

    expect(result).toEqual({ ok: false, error: 'Total payload size exceeds maximum allowed' });
  });

  it('reports an empty result and leaves no folder behind', async () => {
    fakePowerShell();

    const result = await __mock.invoke('clipboard:writeFilesFromData', { files: [{ name: 'a.txt' }] });

    expect(result).toEqual({ ok: false, error: 'No valid files' });
    expect(pasteDir()).toBeNull();
  });

  it('refuses an empty payload', async () => {
    await expect(__mock.invoke('clipboard:writeFilesFromData', { files: [] })).resolves.toEqual({
      ok: false,
      error: 'Invalid payload',
    });
    await expect(__mock.invoke('clipboard:writeFilesFromData', undefined)).resolves.toEqual({
      ok: false,
      error: 'Invalid payload',
    });
  });

  it('refuses outside Windows', async () => {
    usePlatform('linux');
    await expect(__mock.invoke('clipboard:writeFilesFromData', { files: [fileEntry('a.txt', 'X')] })).resolves.toEqual({
      ok: false,
      error: 'Invalid payload',
    });
  });
});

describe('clipboard:claim', () => {
  it('puts the item names on the OS clipboard so older files there count as stale', async () => {
    await expect(__mock.invoke('clipboard:claim', { names: ['a.txt', 'Folder'] })).resolves.toEqual({ ok: true });
    await expect(electron.clipboard.readText()).resolves.toBe('a.txt\nFolder');
  });

  it('leaves the clipboard alone when given no names', async () => {
    __mock.setClipboardText('mine');
    await expect(__mock.invoke('clipboard:claim', { names: [] })).resolves.toEqual({ ok: false });
    await expect(electron.clipboard.readText()).resolves.toBe('mine');
  });

  it('refuses outside Windows', async () => {
    usePlatform('darwin');
    await expect(__mock.invoke('clipboard:claim', { names: ['a.txt'] })).resolves.toEqual({ ok: false });
  });
});

describe('clipboard:writeFilesFromServer', () => {
  const items = [
    { id: '1', name: 'a.txt' },
    { id: '2', name: 'b.txt' },
  ];

  it('gives way when the user copies something else during the download', async () => {
    const spawned = fakePowerShell();
    const copyElsewhere = request => {
      if (!request.url.includes('/download')) return false;
      __mock.setClipboardText('copied elsewhere');
      return true;
    };
    __mock.route(copyElsewhere, { statusCode: 200, body: 'BODY' });

    const result = await __mock.invoke('clipboard:writeFilesFromServer', { origin: SERVER_URL, items });

    expect(result).toEqual({ ok: false, superseded: true });
    expect(pasteDir()).toBeNull();
    expect(spawned).toHaveLength(0);
  });

  it('downloads each item into a paste folder and copies it to the clipboard', async () => {
    fakePowerShell();
    __mock.route('/download', { statusCode: 200, body: 'BODY' });

    const result = await __mock.invoke('clipboard:writeFilesFromServer', { origin: SERVER_URL, items });

    expect(result).toEqual({ ok: true });
    expect(fs.readdirSync(pasteDir()).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses an origin that is not the configured server', async () => {
    fakePowerShell();

    const result = await __mock.invoke('clipboard:writeFilesFromServer', {
      origin: 'https://evil.example.com',
      items,
    });

    expect(result).toEqual({ ok: false, error: 'Invalid or untrusted origin' });
    expect(__mock.requests()).toHaveLength(0);
  });

  it('sanitises and deduplicates the names it writes', async () => {
    fakePowerShell();
    __mock.route('/download', { statusCode: 200, body: 'BODY' });

    await __mock.invoke('clipboard:writeFilesFromServer', {
      origin: SERVER_URL,
      items: [
        { id: '1', name: 'a:b.txt' },
        { id: '2', name: 'a:b.txt' },
      ],
    });

    expect(fs.readdirSync(pasteDir()).sort()).toEqual(['a_b (1).txt', 'a_b.txt']);
  });

  it('skips items with no id or name', async () => {
    fakePowerShell();
    __mock.route('/download', { statusCode: 200, body: 'BODY' });

    await __mock.invoke('clipboard:writeFilesFromServer', {
      origin: SERVER_URL,
      items: [{ id: '1' }, { name: 'b.txt' }, { id: '3', name: 'c.txt' }],
    });

    expect(fs.readdirSync(pasteDir())).toEqual(['c.txt']);
  });

  it('keeps the files that downloaded and discards the partial one', async () => {
    fakePowerShell();
    __mock.route(r => r.url.includes('/files/1/'), { statusCode: 500, body: 'boom' });
    __mock.route('/download', { statusCode: 200, body: 'BODY' });

    const result = await __mock.invoke('clipboard:writeFilesFromServer', { origin: SERVER_URL, items });

    expect(result).toEqual({ ok: true });
    expect(fs.readdirSync(pasteDir())).toEqual(['b.txt']);
  });

  it('reports failure and leaves no folder when nothing could be downloaded', async () => {
    fakePowerShell();
    __mock.route('/download', { statusCode: 500, body: 'boom' });

    const result = await __mock.invoke('clipboard:writeFilesFromServer', { origin: SERVER_URL, items });

    expect(result).toEqual({ ok: false, error: 'Failed to download files' });
    expect(pasteDir()).toBeNull();
  });

  it('refuses an empty item list', async () => {
    await expect(__mock.invoke('clipboard:writeFilesFromServer', { origin: SERVER_URL, items: [] })).resolves.toEqual({
      ok: false,
      error: 'Not available',
    });
  });

  it('refuses outside Windows', async () => {
    usePlatform('darwin');
    await expect(__mock.invoke('clipboard:writeFilesFromServer', { origin: SERVER_URL, items })).resolves.toEqual({
      ok: false,
      error: 'Not available',
    });
  });
});
