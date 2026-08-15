import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __mock } from 'electron';
import updater from '../../src/main/updater.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot } from '../helpers/tempDirs.cjs';

const { downloadAndInstallUpdate } = updater;

const UPDATOR_URL = 'https://updates.example.com/tma';

/*
 * getInstallFileUrl, parseFilenameFromContentDisposition and
 * sanitizeInstallerFilename are internal to the module, so they are exercised
 * through downloadAndInstallUpdate: the URL it requests and the temp file it
 * writes are the observable results of all three.
 */

let tempRoot;

beforeEach(() => {
  tempRoot = createTempRoot('tma-cloud-updatetmp-');
  __mock.state.paths.temp = tempRoot;
  useBuildConfig({ serverUrl: SERVER_URL, updatorUrl: UPDATOR_URL });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The installer file the updater staged in the temp directory, if any. */
function stagedInstaller() {
  const names = fs.readdirSync(tempRoot).filter(n => n.startsWith('tma-cloud-update-'));
  return names.length === 1 ? path.join(tempRoot, names[0]) : null;
}

describe('configuration guards', () => {
  it('refuses to update when no updator URL was configured at build time', async () => {
    useBuildConfig({ serverUrl: SERVER_URL });
    const result = await downloadAndInstallUpdate('1.0.9');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Updator URL is not configured/);
  });

  it('requires a version', async () => {
    await expect(downloadAndInstallUpdate()).resolves.toEqual({ ok: false, error: 'Version is required.' });
    await expect(downloadAndInstallUpdate('')).resolves.toEqual({ ok: false, error: 'Version is required.' });
    await expect(downloadAndInstallUpdate('   ')).resolves.toEqual({ ok: false, error: 'Version is required.' });
    await expect(downloadAndInstallUpdate(42)).resolves.toEqual({ ok: false, error: 'Version is required.' });
  });
});

describe('installer URL', () => {
  it('requests <updatorUrl>/v<version>', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    await downloadAndInstallUpdate('1.0.9');
    expect(__mock.lastRequest().url).toBe(`${UPDATOR_URL}/v1.0.9`);
  });

  it('does not double the "v" when the feed already includes one', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    await downloadAndInstallUpdate('v1.0.9');
    expect(__mock.lastRequest().url).toBe(`${UPDATOR_URL}/v1.0.9`);
  });

  it('does not double the slash when the updator URL has a trailing one', async () => {
    useBuildConfig({ serverUrl: SERVER_URL, updatorUrl: `${UPDATOR_URL}/` });
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    await downloadAndInstallUpdate('1.0.9');
    expect(__mock.lastRequest().url).toBe(`${UPDATOR_URL}/v1.0.9`);
  });

  it('trims whitespace around the version', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    await downloadAndInstallUpdate('  1.0.9  ');
    expect(__mock.lastRequest().url).toBe(`${UPDATOR_URL}/v1.0.9`);
  });
});

describe('installer filename', () => {
  async function downloadWith(contentDisposition) {
    __mock.route('/v1.0.9', {
      statusCode: 200,
      body: 'MZ',
      headers: contentDisposition ? { 'Content-Disposition': contentDisposition } : {},
    });
    const result = await downloadAndInstallUpdate('1.0.9');
    expect(result.ok).toBe(true);
    return path.basename(stagedInstaller());
  }

  it('falls back to a version-stamped name when the server suggests none', async () => {
    expect(await downloadWith(null)).toMatch(/^tma-cloud-update-\d+-TMA-Cloud-Setup-1\.0\.9\.exe$/);
  });

  it('uses the quoted filename from Content-Disposition', async () => {
    expect(await downloadWith('attachment; filename="TMA-Cloud-Setup-1.0.9.exe"')).toContain(
      'TMA-Cloud-Setup-1.0.9.exe'
    );
  });

  it('prefers the RFC 5987 encoded filename when both forms are present', async () => {
    const name = await downloadWith('attachment; filename="fallback.exe"; filename*=UTF-8\'\'TMA%20Cloud%20Setup.exe');
    expect(name).toContain('TMA_Cloud_Setup.exe');
    expect(name).not.toContain('fallback');
  });

  it('accepts the unquoted token form', async () => {
    expect(await downloadWith('attachment; filename=setup.exe')).toContain('setup.exe');
  });

  it('strips directory components so the file cannot escape the temp folder', async () => {
    const name = await downloadWith('attachment; filename="..\\..\\Windows\\System32\\evil.exe"');
    expect(name).not.toContain('..');
    expect(path.dirname(path.join(tempRoot, name))).toBe(tempRoot);
    expect(name).toContain('evil.exe');
  });

  it('collapses a name that is only dots into the safe fallback', async () => {
    expect(await downloadWith('attachment; filename=".."')).toContain('TMA-Cloud-Setup-1.0.9.exe');
  });

  it('replaces characters outside a conservative set', async () => {
    const name = await downloadWith('attachment; filename="se tup;&$.exe"');
    expect(name).toMatch(/^tma-cloud-update-\d+-[\w.-]+$/);
  });

  it('truncates an absurdly long suggestion', async () => {
    const long = `${'a'.repeat(500)}.exe`;
    const name = await downloadWith(`attachment; filename="${long}"`);
    expect(name.length).toBeLessThan(200);
    expect(name.endsWith('.exe')).toBe(true);
  });

  it('keeps the raw value when the RFC 5987 encoding is malformed', async () => {
    const name = await downloadWith("attachment; filename*=UTF-8''bad%ZZname.exe");
    expect(name).toContain('bad_ZZname.exe');
  });
});

describe('download and launch', () => {
  it('writes the downloaded bytes to the temp directory', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: ['MZ', 'PAYLOAD'] });

    const result = await downloadAndInstallUpdate('1.0.9');

    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(stagedInstaller(), 'utf8')).toBe('MZPAYLOAD');
  });

  it('launches the downloaded installer', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    await downloadAndInstallUpdate('1.0.9');
    expect(__mock.state.openPathCalls).toEqual([stagedInstaller()]);
  });

  it('quits shortly after launching so the installer can replace the app', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    await downloadAndInstallUpdate('1.0.9');

    expect(__mock.state.quitCalls).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(__mock.state.quitCalls).toBe(1);
  });

  it('reports progress percentages while a sized download streams', async () => {
    const chunks = ['a'.repeat(25), 'b'.repeat(25), 'c'.repeat(50)];
    __mock.route('/v1.0.9', { statusCode: 200, body: chunks, headers: { 'Content-Length': '100' } });

    const seen = [];
    await downloadAndInstallUpdate('1.0.9', percent => seen.push(percent));

    expect(seen).toEqual([25, 50, 100]);
  });

  it('stays silent about progress when the server sends no Content-Length', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: ['a', 'b'] });
    const seen = [];
    await downloadAndInstallUpdate('1.0.9', percent => seen.push(percent));
    expect(seen).toEqual([]);
  });

  it('waits for the disk to drain before writing the next chunk', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: ['MZ', 'PART TWO'] });
    const realCreate = fs.createWriteStream;
    vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      const stream = realCreate(...args);
      const realWrite = stream.write.bind(stream);
      let first = true;
      stream.write = (chunk, callback) => {
        const result = realWrite(chunk, callback);
        if (first) {
          first = false;
          setImmediate(() => stream.emit('drain'));
          return false;
        }
        return result;
      };
      return stream;
    });

    const result = await downloadAndInstallUpdate('1.0.9');

    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(stagedInstaller(), 'utf8')).toBe('MZPART TWO');
  });

  it('reports a failed download with the status and the URL it tried', async () => {
    __mock.route('/v1.0.9', { statusCode: 404, body: '' });
    const result = await downloadAndInstallUpdate('1.0.9');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
    expect(result.error).toContain(`${UPDATOR_URL}/v1.0.9`);
  });

  it('reports a transport failure instead of throwing', async () => {
    __mock.routeError('/v1.0.9', new Error('ENOTFOUND updates.example.com'));
    const result = await downloadAndInstallUpdate('1.0.9');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
  });

  it('leaves no partial installer behind when the stream fails midway', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = await downloadAndInstallUpdate('1.0.9');

    expect(result.ok).toBe(false);
    expect(stagedInstaller()).toBeNull();
  });

  it('reports the reason when the installer cannot be launched', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    __mock.setOpenPathResult('No application is associated with this file');

    const result = await downloadAndInstallUpdate('1.0.9');

    expect(result).toEqual({ ok: false, error: 'No application is associated with this file' });
  });

  it('does not quit when launching the installer failed', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ' });
    __mock.setOpenPathResult('failed');

    await downloadAndInstallUpdate('1.0.9');
    vi.advanceTimersByTime(5000);

    expect(__mock.state.quitCalls).toBe(0);
  });
});
