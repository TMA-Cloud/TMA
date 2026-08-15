import crypto from 'crypto';
import fs from 'fs';
import { PassThrough } from 'stream';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { __mock } from 'electron';
import fileUtils from '../../src/main/utils/file-utils.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot, redirectTmpdir, writeFile } from '../helpers/tempDirs.cjs';
import { fakeSpawnResult } from '../helpers/childProcess.cjs';

const {
  PASTE_DIR_PREFIX,
  EDIT_DIR_PREFIX,
  sanitizeFileName,
  deduplicateFileName,
  createTempDir,
  downloadToFile,
  downloadPostToFile,
  getFileInfoFromBackend,
  setClipboardToPaths,
  cleanTempDirsByPrefix,
  cleanTempClipboardDirs,
  cleanTempEditDirs,
  uploadFileToReplace,
  uploadDerivedFile,
  hashFile,
  validateOrigin,
  getJson,
  apiPostJson,
  listFilesFromBackend,
  uploadNewFile,
  getCookieHeader,
} = fileUtils;

describe('sanitizeFileName', () => {
  it('replaces every character Windows forbids in a filename', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('strips surrounding whitespace', () => {
    expect(sanitizeFileName('  report.pdf  ')).toBe('report.pdf');
  });

  it('falls back to "file" when nothing usable is left', () => {
    expect(sanitizeFileName('   ')).toBe('file');
  });

  it('keeps unicode and spaces inside the name', () => {
    expect(sanitizeFileName('déjà vu.txt')).toBe('déjà vu.txt');
  });

  it('does not let a traversal sequence survive as a path', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(path.basename(sanitizeFileName('../../etc/passwd'))).toBe('.._.._etc_passwd');
  });
});

describe('deduplicateFileName', () => {
  it('returns the name unchanged when it has not been seen', () => {
    expect(deduplicateFileName('a.txt', new Set())).toBe('a.txt');
  });

  it('inserts the counter before the extension', () => {
    expect(deduplicateFileName('a.txt', new Set(['a.txt']))).toBe('a (1).txt');
  });

  it('keeps counting until it finds a free name', () => {
    const seen = new Set(['a.txt', 'a (1).txt', 'a (2).txt']);
    expect(deduplicateFileName('a.txt', seen)).toBe('a (3).txt');
  });

  it('appends the counter at the end when there is no extension', () => {
    expect(deduplicateFileName('README', new Set(['README']))).toBe('README (1)');
  });

  it('treats a dotfile name as having no stem to split', () => {
    expect(deduplicateFileName('.env', new Set(['.env']))).toBe('.env (1)');
  });
});

describe('validateOrigin', () => {
  it('accepts the configured server origin', () => {
    useBuildConfig({ serverUrl: SERVER_URL });
    expect(validateOrigin(SERVER_URL)).toBe(SERVER_URL);
  });

  it('ignores any path on the incoming value and returns the bare origin', () => {
    useBuildConfig({ serverUrl: `${SERVER_URL}/app` });
    expect(validateOrigin(`${SERVER_URL}/files/1`)).toBe(SERVER_URL);
  });

  it('rejects a different host', () => {
    useBuildConfig({ serverUrl: SERVER_URL });
    expect(validateOrigin('https://evil.example.com')).toBeNull();
  });

  it('rejects a host that merely starts with the trusted one', () => {
    useBuildConfig({ serverUrl: SERVER_URL });
    expect(validateOrigin('https://cloud.example.com.evil.net')).toBeNull();
  });

  it('rejects a different scheme or port, which are part of the origin', () => {
    useBuildConfig({ serverUrl: 'https://cloud.example.com' });
    expect(validateOrigin('http://cloud.example.com')).toBeNull();
    expect(validateOrigin('https://cloud.example.com:8443')).toBeNull();
  });

  it('rejects anything that is not a parseable URL', () => {
    useBuildConfig({ serverUrl: SERVER_URL });
    expect(validateOrigin('not a url')).toBeNull();
    expect(validateOrigin('')).toBeNull();
    expect(validateOrigin(null)).toBeNull();
    expect(validateOrigin(42)).toBeNull();
  });

  it('rejects everything when no server URL is configured', () => {
    useBuildConfig(null);
    expect(validateOrigin(SERVER_URL)).toBeNull();
  });
});

describe('getCookieHeader', () => {
  it('joins the session cookies into a single header value', async () => {
    __mock.setCookies([
      { name: 'token', value: 'abc' },
      { name: 'theme', value: 'dark' },
    ]);
    expect(await getCookieHeader(SERVER_URL)).toBe('token=abc; theme=dark');
  });

  it('returns an empty string when there are no cookies', async () => {
    __mock.setCookies([]);
    expect(await getCookieHeader(SERVER_URL)).toBe('');
  });

  it('returns an empty string rather than failing when the cookie store errors', async () => {
    __mock.setCookieError(new Error('store unavailable'));
    expect(await getCookieHeader(SERVER_URL)).toBe('');
  });
});

describe('downloadToFile', () => {
  it('writes the response body to the target path', async () => {
    const dir = createTempRoot();
    const target = path.join(dir, 'out.bin');
    __mock.route('/download', { statusCode: 200, body: ['hello ', 'world'] });

    await downloadToFile(`${SERVER_URL}/api/files/1/download`, target);

    expect(fs.readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('sends the session cookies so the download is authenticated', async () => {
    const dir = createTempRoot();
    __mock.setCookies([{ name: 'token', value: 'abc' }]);
    __mock.route('/download', { statusCode: 200, body: 'x' });

    await downloadToFile(`${SERVER_URL}/api/files/1/download`, path.join(dir, 'out.bin'));

    expect(__mock.lastRequest().headers.Cookie).toBe('token=abc');
  });

  it('rejects with the status and body when the server refuses', async () => {
    const dir = createTempRoot();
    __mock.route('/download', { statusCode: 403, body: 'forbidden' });

    await expect(downloadToFile(`${SERVER_URL}/api/files/1/download`, path.join(dir, 'out.bin'))).rejects.toThrow(
      'Download failed (403): forbidden'
    );
  });

  it('caps how much of an error body it quotes back', async () => {
    const dir = createTempRoot();
    __mock.route('/download', { statusCode: 500, body: 'x'.repeat(100000) });

    await expect(downloadToFile(`${SERVER_URL}/api/files/1/download`, path.join(dir, 'out.bin'))).rejects.toThrow(
      /Download failed \(500\)/
    );
  });

  it('rejects when the transport fails', async () => {
    const dir = createTempRoot();
    __mock.routeError('/download', new Error('ECONNREFUSED'));

    await expect(downloadToFile(`${SERVER_URL}/api/files/1/download`, path.join(dir, 'out.bin'))).rejects.toThrow(
      'ECONNREFUSED'
    );
  });

  it('pauses and resumes the response when the disk cannot keep up', async () => {
    const target = path.join(createTempRoot(), 'out.bin');
    __mock.route('/download', { statusCode: 200, body: ['chunk one', 'chunk two'] });
    const realCreate = fs.createWriteStream;
    vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      const stream = realCreate(...args);
      const realWrite = stream.write.bind(stream);
      let first = true;
      stream.write = chunk => {
        const result = realWrite(chunk);
        if (first) {
          first = false;
          setImmediate(() => stream.emit('drain'));
          return false;
        }
        return result;
      };
      return stream;
    });

    await downloadToFile(`${SERVER_URL}/api/files/1/download`, target);

    expect(fs.readFileSync(target, 'utf8')).toBe('chunk onechunk two');
  });

  it('rejects and tears down the response when writing to disk fails', async () => {
    __mock.route('/download', { statusCode: 200, body: 'x' });
    const failing = new PassThrough();
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => {
      setImmediate(() => failing.emit('error', new Error('ENOSPC: no space left on device')));
      return failing;
    });

    await expect(
      downloadToFile(`${SERVER_URL}/api/files/1/download`, path.join(createTempRoot(), 'out.bin'))
    ).rejects.toThrow('ENOSPC');
  });
});

describe('downloadPostToFile', () => {
  it('posts the JSON body and streams the response to disk', async () => {
    const dir = createTempRoot();
    const target = path.join(dir, 'bundle.zip');
    __mock.route('/download/bulk', { statusCode: 200, body: 'ZIPDATA' });

    await downloadPostToFile(`${SERVER_URL}/api/files/download/bulk`, { ids: [1, 2] }, target);

    const request = __mock.lastRequest();
    expect(request.method).toBe('POST');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(request.bodyText())).toEqual({ ids: [1, 2] });
    expect(fs.readFileSync(target, 'utf8')).toBe('ZIPDATA');
  });

  it('rejects with the server error instead of leaving a truncated file', async () => {
    const dir = createTempRoot();
    __mock.route('/download/bulk', { statusCode: 413, body: 'too large' });

    await expect(
      downloadPostToFile(`${SERVER_URL}/api/files/download/bulk`, { ids: [1] }, path.join(dir, 'bundle.zip'))
    ).rejects.toThrow('Download failed (413): too large');
  });
});

describe('getFileInfoFromBackend', () => {
  it('requests the info endpoint for the given id and parses the payload', async () => {
    __mock.route('/info', { statusCode: 200, body: JSON.stringify({ size: 10, modified: '2026-01-01T00:00:00Z' }) });

    const info = await getFileInfoFromBackend(SERVER_URL, 'abc 1');

    expect(__mock.lastRequest().url).toBe(`${SERVER_URL}/api/files/abc%201/info`);
    expect(info).toEqual({ size: 10, modified: '2026-01-01T00:00:00Z' });
  });

  it('rejects on a non-2xx status', async () => {
    __mock.route('/info', { statusCode: 404, body: 'not found' });
    await expect(getFileInfoFromBackend(SERVER_URL, '1')).rejects.toThrow('File info failed (404): not found');
  });

  it('rejects when the body is not valid JSON', async () => {
    __mock.route('/info', { statusCode: 200, body: '<html>' });
    await expect(getFileInfoFromBackend(SERVER_URL, '1')).rejects.toThrow();
  });

  it('resolves to an empty object for an empty 200 body', async () => {
    __mock.route('/info', { statusCode: 200, body: '' });
    await expect(getFileInfoFromBackend(SERVER_URL, '1')).resolves.toEqual({});
  });
});

describe('getJson', () => {
  it('sends the cookie header it is given', async () => {
    __mock.route('/api/user/storage', { statusCode: 200, body: '{"used":1}' });
    await getJson(`${SERVER_URL}/api/user/storage`, 'token=abc');
    expect(__mock.lastRequest().headers.Cookie).toBe('token=abc');
  });

  it('rejects with the status and body on failure', async () => {
    __mock.route('/api/user/storage', { statusCode: 401, body: 'unauthorized' });
    await expect(getJson(`${SERVER_URL}/api/user/storage`, '')).rejects.toThrow('GET failed (401): unauthorized');
  });

  it('resolves to null for an empty body', async () => {
    __mock.route('/api/user/storage', { statusCode: 200, body: '' });
    await expect(getJson(`${SERVER_URL}/api/user/storage`, '')).resolves.toBeNull();
  });
});

describe('apiPostJson', () => {
  it('posts the body as JSON with the session cookies attached', async () => {
    __mock.setCookies([{ name: 'token', value: 'abc' }]);
    __mock.route('/api/files/rename', { statusCode: 200, body: '{"ok":true}' });

    const result = await apiPostJson(SERVER_URL, '/api/files/rename', { id: '1', name: 'new.txt' });

    const request = __mock.lastRequest();
    expect(request.url).toBe(`${SERVER_URL}/api/files/rename`);
    expect(request.headers.Cookie).toBe('token=abc');
    expect(JSON.parse(request.bodyText())).toEqual({ id: '1', name: 'new.txt' });
    expect(result).toEqual({ ok: true });
  });

  it('names the failing route in the error so bridge logs are readable', async () => {
    __mock.route('/api/files/delete', { statusCode: 403, body: 'denied' });
    await expect(apiPostJson(SERVER_URL, '/api/files/delete', { ids: ['1'] })).rejects.toThrow(
      '/api/files/delete failed (403): denied'
    );
  });

  it('resolves to an empty object when a success response is not JSON', async () => {
    __mock.route('/api/files/move', { statusCode: 200, body: 'OK' });
    await expect(apiPostJson(SERVER_URL, '/api/files/move', {})).resolves.toEqual({});
  });
});

describe('listFilesFromBackend', () => {
  it('lists the root when no parent is given', async () => {
    __mock.route('/api/files', { statusCode: 200, body: '[]' });
    await listFilesFromBackend(SERVER_URL, null);
    expect(__mock.lastRequest().url).toBe(`${SERVER_URL}/api/files`);
  });

  it('encodes the parent id into the query string', async () => {
    __mock.route('/api/files', { statusCode: 200, body: '[]' });
    await listFilesFromBackend(SERVER_URL, 'a b&c');
    expect(__mock.lastRequest().url).toBe(`${SERVER_URL}/api/files?parentId=a%20b%26c`);
  });
});

describe('multipart uploads', () => {
  function stagedFile(contents = 'file body') {
    const dir = createTempRoot();
    return writeFile(dir, 'report.docx', contents);
  }

  it('replaces an existing file through the replace endpoint', async () => {
    __mock.route('/replace', { statusCode: 200, body: '' });
    await uploadFileToReplace(SERVER_URL, 'file 1', stagedFile(), 'report.docx');

    const request = __mock.lastRequest();
    expect(request.url).toBe(`${SERVER_URL}/api/files/file%201/replace`);
    expect(request.method).toBe('POST');
    expect(request.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=----ElectronFormBoundary/);
  });

  it('sends the file part with a filename and a resolved content type', async () => {
    __mock.route('/replace', { statusCode: 200, body: '' });
    await uploadFileToReplace(SERVER_URL, '1', stagedFile('file body'), 'report.docx');

    const body = __mock.lastRequest().bodyText();
    expect(body).toContain('Content-Disposition: form-data; name="file"; filename="report.docx"');
    expect(body).toContain('Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(body).toContain('file body');
    expect(body.trimEnd().endsWith('--')).toBe(true);
  });

  it('escapes a quote in the filename so the part header stays well formed', async () => {
    __mock.route('/replace', { statusCode: 200, body: '' });
    await uploadFileToReplace(SERVER_URL, '1', stagedFile(), 'we"ird.docx');
    expect(__mock.lastRequest().bodyText()).toContain('filename="we\\"ird.docx"');
  });

  it('falls back to a binary content type for an unknown extension', async () => {
    __mock.route('/replace', { statusCode: 200, body: '' });
    await uploadFileToReplace(SERVER_URL, '1', stagedFile(), 'thing.zzzzz');
    expect(__mock.lastRequest().bodyText()).toContain('Content-Type: application/octet-stream');
  });

  it('uploads an exported file through the derived endpoint of the original', async () => {
    __mock.route('/derived', { statusCode: 200, body: '' });
    await uploadDerivedFile(SERVER_URL, '7', stagedFile(), 'report.pdf');
    expect(__mock.lastRequest().url).toBe(`${SERVER_URL}/api/files/7/derived`);
  });

  it('rejects with the server message when an upload is refused', async () => {
    __mock.route('/replace', { statusCode: 507, body: 'quota exceeded' });
    await expect(uploadFileToReplace(SERVER_URL, '1', stagedFile(), 'report.docx')).rejects.toThrow(
      'Upload failed (507): quota exceeded'
    );
  });

  it('finishes the upload after the connection applies back-pressure', async () => {
    __mock.setBackpressure(true);
    __mock.route('/replace', { statusCode: 200, body: '' });

    await uploadFileToReplace(SERVER_URL, '1', stagedFile('file body'), 'report.docx');

    const body = __mock.lastRequest().bodyText();
    expect(body).toContain('file body');
    expect(body.trimEnd().endsWith('--')).toBe(true);
  });

  it('rejects when the local file disappeared before the upload', async () => {
    __mock.route('/replace', { statusCode: 200, body: '' });
    const missing = path.join(createTempRoot(), 'gone.docx');
    await expect(uploadFileToReplace(SERVER_URL, '1', missing, 'gone.docx')).rejects.toThrow();
  });
});

describe('uploadNewFile', () => {
  function stagedFile(name = 'note.txt', contents = 'body') {
    return writeFile(createTempRoot(), name, contents);
  }

  it('emits the parentId field before the file part, as the stream parser requires', async () => {
    __mock.route('/api/files/upload', { statusCode: 200, body: '{"id":"new-1"}' });
    await uploadNewFile(SERVER_URL, 'folder-9', stagedFile(), 'note.txt');

    const body = __mock.lastRequest().bodyText();
    expect(body.indexOf('name="parentId"')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('name="parentId"')).toBeLessThan(body.indexOf('name="file"'));
    expect(body).toContain('folder-9');
  });

  it('omits the parentId field entirely when uploading to the root', async () => {
    __mock.route('/api/files/upload', { statusCode: 200, body: '{}' });
    await uploadNewFile(SERVER_URL, null, stagedFile(), 'note.txt');
    expect(__mock.lastRequest().bodyText()).not.toContain('name="parentId"');
  });

  it('returns the created file so the caller learns its new id', async () => {
    __mock.route('/api/files/upload', { statusCode: 200, body: '{"id":"new-1","name":"note.txt"}' });
    await expect(uploadNewFile(SERVER_URL, null, stagedFile(), 'note.txt')).resolves.toEqual({
      id: 'new-1',
      name: 'note.txt',
    });
  });

  it('rejects with the server error on failure', async () => {
    __mock.route('/api/files/upload', { statusCode: 400, body: 'bad name' });
    await expect(uploadNewFile(SERVER_URL, null, stagedFile(), 'note.txt')).rejects.toThrow(
      'Upload failed (400): bad name'
    );
  });
});

describe('hashFile', () => {
  it('produces the sha256 of the file contents', async () => {
    const file = writeFile(createTempRoot(), 'a.txt', 'hello');
    const expected = crypto.createHash('sha256').update('hello').digest('hex');
    await expect(hashFile(file)).resolves.toBe(expected);
  });

  it('changes when a single byte changes, which is what drives re-upload', async () => {
    const dir = createTempRoot();
    const file = writeFile(dir, 'a.txt', 'hello');
    const before = await hashFile(file);
    fs.writeFileSync(file, 'hellp');
    expect(await hashFile(file)).not.toBe(before);
  });

  it('rejects when the file does not exist', async () => {
    await expect(hashFile(path.join(createTempRoot(), 'missing.txt'))).rejects.toThrow();
  });
});

describe('createTempDir', () => {
  it('creates a directory under the system temp folder with the given prefix', () => {
    const root = redirectTmpdir(vi);
    const dir = createTempDir(EDIT_DIR_PREFIX);
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(root);
    expect(path.basename(dir).startsWith(EDIT_DIR_PREFIX)).toBe(true);
  });
});

describe('cleanTempDirsByPrefix', () => {
  function agedDir(root, name, ageMs) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    writeFile(dir, 'inside.txt', 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  }

  it('removes directories older than the cutoff', () => {
    const root = redirectTmpdir(vi);
    const old = agedDir(root, `${PASTE_DIR_PREFIX}old`, 48 * 60 * 60 * 1000);
    cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 24 * 60 * 60 * 1000);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('keeps directories that are still within the cutoff', () => {
    const root = redirectTmpdir(vi);
    const fresh = agedDir(root, `${PASTE_DIR_PREFIX}fresh`, 60 * 1000);
    cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 24 * 60 * 60 * 1000);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('removes everything when the cutoff is zero, as it is on quit', () => {
    const root = redirectTmpdir(vi);
    const fresh = agedDir(root, `${PASTE_DIR_PREFIX}fresh`, 1000);
    cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it('leaves a directory stamped in the future alone, so clock skew deletes nothing', () => {
    const root = redirectTmpdir(vi);
    const future = agedDir(root, `${PASTE_DIR_PREFIX}future`, -60 * 1000);

    cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);

    // The same rule means a folder created within the current millisecond can
    // survive one quit-time sweep; the next sweep collects it.
    expect(fs.existsSync(future)).toBe(true);
  });

  it('never touches directories with a different prefix', () => {
    const root = redirectTmpdir(vi);
    const other = agedDir(root, `${EDIT_DIR_PREFIX}old`, 48 * 60 * 60 * 1000);
    const unrelated = agedDir(root, 'something-else', 48 * 60 * 60 * 1000);
    cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('skips directories an active session still needs', () => {
    const root = redirectTmpdir(vi);
    const active = agedDir(root, `${EDIT_DIR_PREFIX}active`, 48 * 60 * 60 * 1000);
    const stale = agedDir(root, `${EDIT_DIR_PREFIX}stale`, 48 * 60 * 60 * 1000);

    cleanTempDirsByPrefix(EDIT_DIR_PREFIX, 0, new Set([active]));

    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('ignores loose files that happen to share the prefix', () => {
    const root = redirectTmpdir(vi);
    const file = writeFile(root, `${PASTE_DIR_PREFIX}notadir`, 'x');
    cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('does nothing when the temp root cannot be read', () => {
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => cleanTempDirsByPrefix(PASTE_DIR_PREFIX, 0)).not.toThrow();
  });

  it('exposes the two prefixes through their own named cleaners', () => {
    const root = redirectTmpdir(vi);
    const paste = agedDir(root, `${PASTE_DIR_PREFIX}a`, 0);
    const edit = agedDir(root, `${EDIT_DIR_PREFIX}a`, 0);

    cleanTempClipboardDirs(0);
    expect(fs.existsSync(paste)).toBe(false);
    expect(fs.existsSync(edit)).toBe(true);

    cleanTempEditDirs(0);
    expect(fs.existsSync(edit)).toBe(false);
  });
});

describe('setClipboardToPaths', () => {
  it('writes the paths to a temp list and hands it to PowerShell', async () => {
    redirectTmpdir(vi);
    const spawned = fakeSpawnResult(vi, { stdout: '' });
    const file = writeFile(createTempRoot(), 'a.txt', 'x');

    await setClipboardToPaths([file]);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].args[2]).toContain('SetFileDropList');
  });

  it('deletes the temp list once the clipboard has been set', async () => {
    const root = redirectTmpdir(vi);
    fakeSpawnResult(vi, { stdout: '' });
    await setClipboardToPaths([writeFile(createTempRoot(), 'a.txt', 'x')]);

    const leftovers = fs.readdirSync(root).filter(name => name.startsWith('electron-desktop-'));
    expect(leftovers).toEqual([]);
  });

  it('does nothing at all when there are no paths', async () => {
    const spawned = fakeSpawnResult(vi, { stdout: '' });
    await setClipboardToPaths([]);
    await setClipboardToPaths(undefined);
    expect(spawned).toHaveLength(0);
  });

  it('drops paths containing newlines or NUL so they cannot forge extra entries', async () => {
    const root = redirectTmpdir(vi);
    let listContents = null;
    const spawned = fakeSpawnResult(vi, { stdout: '' });

    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, enc) => {
      if (String(target).includes('electron-desktop-')) listContents = String(data);
      return realWrite(target, data, enc);
    });

    await setClipboardToPaths(['C:\\ok.txt', 'C:\\bad\nC:\\extra.txt', 'C:\\nul\0.txt', '', 42]);

    expect(listContents).toBe('C:\\ok.txt');
    expect(spawned).toHaveLength(1);
    expect(fs.readdirSync(root).filter(n => n.startsWith('electron-desktop-'))).toEqual([]);
  });
});
