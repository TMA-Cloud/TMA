import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot, redirectTmpdir, writeFile } from '../helpers/tempDirs.cjs';
import { fakeSpawn } from '../helpers/childProcess.cjs';
import { usePlatform } from '../helpers/platform.cjs';

const PASTE_DIR_PREFIX = 'tma-cloud-paste-';

let tmpRoot;

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
      'clipboard:peekFileNames',
      'clipboard:readFiles',
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

    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: ['a.txt', 'b.png'] });
  });

  it('returns nothing when the clipboard holds no files', async () => {
    fakePowerShell({ dropList: '' });
    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: [] });
  });

  it('returns nothing rather than failing when PowerShell errors', async () => {
    fakePowerShell({ dropListFails: true });
    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: [] });
  });

  it('returns nothing outside Windows', async () => {
    usePlatform('darwin');
    const spawned = fakePowerShell({ dropList: 'C:\\a.txt' });
    await expect(__mock.invoke('clipboard:peekFileNames')).resolves.toEqual({ names: [] });
    expect(spawned).toHaveLength(0);
  });
});

describe('clipboard:readFiles', () => {
  it('reads the files Explorer put on the clipboard, with contents and type', async () => {
    const dir = createTempRoot();
    const file = writeFile(dir, 'note.txt', 'hello');
    fakePowerShell({ dropList: `${file}\r\n` });

    const { files } = await __mock.invoke('clipboard:readFiles');

    expect(files).toEqual([{ name: 'note.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') }]);
  });

  it('skips directories and unreadable entries in the drop list', async () => {
    const dir = createTempRoot();
    const file = writeFile(dir, 'note.txt', 'hello');
    const subdir = path.join(dir, 'folder');
    fs.mkdirSync(subdir);
    fakePowerShell({ dropList: `${subdir}\r\n${path.join(dir, 'missing.txt')}\r\n${file}\r\n` });

    const { files } = await __mock.invoke('clipboard:readFiles');

    expect(files.map(f => f.name)).toEqual(['note.txt']);
  });

  it('falls back to the OLE clipboard for Outlook attachments and screenshots', async () => {
    const payload = JSON.stringify({ 'shot.png': Buffer.from('PNG').toString('base64') });
    fakePowerShell({ dropList: '', ole: payload });

    const { files } = await __mock.invoke('clipboard:readFiles');

    expect(files).toEqual([{ name: 'shot.png', mime: 'image/png', data: Buffer.from('PNG').toString('base64') }]);
  });

  it('falls through to clipboard text that contains file paths', async () => {
    fakePowerShell({ dropList: '', ole: '{}' });
    // Only drive-letter and UNC paths are recognised, so the fixture is a
    // Windows path with the filesystem stubbed — this runs on Linux CI too.
    const copied = 'C:\\Users\\me\\copied.txt';
    __mock.setClipboardText(`"${copied}"`);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true });
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('body'));

    const { files } = await __mock.invoke('clipboard:readFiles');

    expect(files).toEqual([
      // path.basename splits Windows separators only on Windows; the name is
      // derived the same way the handler derives it.
      { name: path.basename(copied), mime: 'text/plain', data: Buffer.from('body').toString('base64') },
    ]);
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
    const file = writeFile(createTempRoot(), 'thing.zzzzz', 'x');
    fakePowerShell({ dropList: `${file}\r\n` });

    const { files } = await __mock.invoke('clipboard:readFiles');

    expect(files[0].mime).toBe('application/octet-stream');
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

describe('clipboard:writeFilesFromServer', () => {
  const items = [
    { id: '1', name: 'a.txt' },
    { id: '2', name: 'b.txt' },
  ];

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
