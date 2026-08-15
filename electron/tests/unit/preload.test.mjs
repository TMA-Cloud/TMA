import { beforeEach, describe, expect, it, vi } from 'vitest';

import electron, { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';

/** The API object the preload script published to the page. */
let api;

beforeEach(() => {
  freshRequire('src/preload/index.cjs');
  api = __mock.state.exposed.value;
});

describe('what the bridge exposes', () => {
  it('publishes the API under a single well-known name', () => {
    expect(__mock.state.exposed.key).toBe('electronAPI');
  });

  it('tells the page which platform it is running on', () => {
    expect(api.platform).toBe(process.platform);
  });

  it('exposes only the four feature groups the web app uses', () => {
    expect(Object.keys(api).sort()).toEqual(['app', 'clipboard', 'cloudDrive', 'files', 'platform']);
  });

  it('never hands the page a generic way to reach the main process', () => {
    const flattened = JSON.stringify(api, (_key, value) => (typeof value === 'function' ? 'fn' : value));
    expect(flattened).not.toContain('ipcRenderer');
    expect(api.send).toBeUndefined();
    expect(api.invoke).toBeUndefined();
    expect(api.require).toBeUndefined();
  });
});

describe('channel mapping', () => {
  const cases = [
    ['clipboard.peekFileNames', () => api.clipboard.peekFileNames(), 'clipboard:peekFileNames', undefined],
    ['clipboard.readFiles', () => api.clipboard.readFiles(), 'clipboard:readFiles', undefined],
    ['clipboard.writeFiles', () => api.clipboard.writeFiles(['C:\\a.txt']), 'clipboard:writeFiles', ['C:\\a.txt']],
    [
      'clipboard.writeFilesFromData',
      () => api.clipboard.writeFilesFromData({ files: [] }),
      'clipboard:writeFilesFromData',
      { files: [] },
    ],
    [
      'clipboard.writeFilesFromServer',
      () => api.clipboard.writeFilesFromServer({ items: [] }),
      'clipboard:writeFilesFromServer',
      { items: [] },
    ],
    ['files.editWithDesktop', () => api.files.editWithDesktop({ id: '1' }), 'files:editWithDesktop', { id: '1' }],
    ['files.saveFile', () => api.files.saveFile({ fileId: '1' }), 'files:saveFile', { fileId: '1' }],
    ['files.saveFilesBulk', () => api.files.saveFilesBulk({ ids: ['1'] }), 'files:saveFilesBulk', { ids: ['1'] }],
    ['app.getVersion', () => api.app.getVersion(), 'app:getVersion', undefined],
    [
      'app.downloadAndInstallUpdate',
      () => api.app.downloadAndInstallUpdate('1.0.9'),
      'app:downloadAndInstallUpdate',
      '1.0.9',
    ],
    ['cloudDrive.stop', () => api.cloudDrive.stop(), 'clouddrive:stop', undefined],
    ['cloudDrive.status', () => api.cloudDrive.status(), 'clouddrive:status', undefined],
    ['cloudDrive.getMode', () => api.cloudDrive.getMode(), 'clouddrive:getMode', undefined],
    ['cloudDrive.setMode', () => api.cloudDrive.setMode('full'), 'clouddrive:setMode', 'full'],
  ];

  it.each(cases)('%s invokes %s', (_name, call, channel, payload) => {
    call();
    const invocation = __mock.state.rendererInvocations.at(-1);
    expect(invocation[0]).toBe(channel);
    expect(invocation[1]).toEqual(payload);
  });

  it('starts the cloud drive with an options object even when called with none', () => {
    api.cloudDrive.start();
    expect(__mock.state.rendererInvocations.at(-1)).toEqual(['clouddrive:start', {}]);
  });

  it('passes cloud drive options through when given', () => {
    api.cloudDrive.start({ mount: 'Z:' });
    expect(__mock.state.rendererInvocations.at(-1)).toEqual(['clouddrive:start', { mount: 'Z:' }]);
  });
});

describe('event subscriptions', () => {
  it('delivers derived upload status to the subscriber', () => {
    const seen = [];

    api.files.onDerivedUploadStatus(payload => seen.push(payload));
    const { listener } = __mock.state.rendererListeners.at(-1);
    listener({}, { state: 'completed', fileName: 'report.pdf' });

    expect(seen).toEqual([{ state: 'completed', fileName: 'report.pdf' }]);
  });

  it('returns an unsubscribe function that removes the listener', () => {
    const unsubscribe = api.files.onDerivedUploadStatus(() => {});
    expect(__mock.state.rendererListeners).toHaveLength(1);

    unsubscribe();

    expect(__mock.state.rendererListeners).toHaveLength(0);
  });

  it('does not subscribe at all when handed something that is not a function', () => {
    const unsubscribe = api.files.onDerivedUploadStatus('not a function');

    expect(__mock.state.rendererListeners).toHaveLength(0);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('keeps the app alive when a status callback throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.files.onDerivedUploadStatus(() => {
      throw new Error('render error');
    });
    const { listener } = __mock.state.rendererListeners.at(-1);

    expect(() => listener({}, { state: 'started' })).not.toThrow();
  });

  it('delivers update download progress as a plain percentage', () => {
    const seen = [];

    api.app.onUpdateDownloadProgress(percent => seen.push(percent));
    const { channel, listener } = __mock.state.rendererListeners.at(-1);
    listener({}, 42);

    expect(channel).toBe('app:updateDownloadProgress');
    expect(seen).toEqual([42]);
  });

  it('unsubscribes from update progress on request', () => {
    const unsubscribe = api.app.onUpdateDownloadProgress(() => {});
    unsubscribe();
    expect(__mock.state.rendererListeners).toHaveLength(0);
  });

  it('ignores a non-function progress callback', () => {
    expect(() => api.app.onUpdateDownloadProgress(null)()).not.toThrow();
    expect(__mock.state.rendererListeners).toHaveLength(0);
  });
});

describe('when the bridge cannot be built', () => {
  it('still publishes a minimal object so the page can detect the desktop app', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(electron.contextBridge, 'exposeInMainWorld').mockImplementationOnce(() => {
      throw new Error('contextBridge unavailable');
    });

    freshRequire('src/preload/index.cjs');

    expect(__mock.state.exposed.key).toBe('electronAPI');
    expect(__mock.state.exposed.value).toEqual({
      platform: process.platform,
      clipboard: {},
      files: {},
    });
  });
});
