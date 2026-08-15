import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot } from '../helpers/tempDirs.cjs';

const UPDATOR_URL = 'https://updates.example.com/tma';

beforeEach(() => {
  freshRequire('src/main/ipc/app.cjs').registerAppHandlers();
});

describe('handler registration', () => {
  it('exposes exactly the two app channels the preload bridge calls', () => {
    expect(__mock.handlerChannels().sort()).toEqual(['app:downloadAndInstallUpdate', 'app:getVersion']);
  });
});

describe('app:getVersion', () => {
  it('returns the packaged app version', async () => {
    __mock.setVersion('1.0.8');
    await expect(__mock.invoke('app:getVersion')).resolves.toEqual({ version: '1.0.8' });
  });

  it('reports the failure instead of rejecting, so the renderer can still render', async () => {
    __mock.setVersion(new Error('no version'));
    await expect(__mock.invoke('app:getVersion')).resolves.toEqual({ version: null, error: 'no version' });
  });
});

describe('app:downloadAndInstallUpdate', () => {
  beforeEach(() => {
    __mock.state.paths.temp = createTempRoot('tma-cloud-updatetmp-');
    useBuildConfig({ serverUrl: SERVER_URL, updatorUrl: UPDATOR_URL });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    return () => vi.useRealTimers();
  });

  it('forwards download progress to the renderer that asked for the update', async () => {
    __mock.route('/v1.0.9', {
      statusCode: 200,
      body: ['a'.repeat(50), 'b'.repeat(50)],
      headers: { 'Content-Length': '100' },
    });
    const sent = [];
    const sender = { send: (channel, payload) => sent.push({ channel, payload }) };

    await __mock.invoke('app:downloadAndInstallUpdate', '1.0.9', { sender });

    expect(sent).toEqual([
      { channel: 'app:updateDownloadProgress', payload: 50 },
      { channel: 'app:updateDownloadProgress', payload: 100 },
    ]);
  });

  it('keeps downloading when the renderer has gone and the send throws', async () => {
    __mock.route('/v1.0.9', { statusCode: 200, body: 'MZ', headers: { 'Content-Length': '2' } });
    const sender = {
      send: () => {
        throw new Error('Object has been destroyed');
      },
    };

    await expect(__mock.invoke('app:downloadAndInstallUpdate', '1.0.9', { sender })).resolves.toEqual({ ok: true });
  });

  it('passes the version through to the updater', async () => {
    __mock.route('/v2.0.0', { statusCode: 200, body: 'MZ' });
    await __mock.invoke('app:downloadAndInstallUpdate', '2.0.0', { sender: { send: () => {} } });
    expect(__mock.lastRequest().url).toBe(`${UPDATOR_URL}/v2.0.0`);
  });

  it('returns the updater error rather than throwing across IPC', async () => {
    __mock.routeError('/v1.0.9', new Error('ENOTFOUND'));
    const result = await __mock.invoke('app:downloadAndInstallUpdate', '1.0.9', { sender: { send: () => {} } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
  });
});
