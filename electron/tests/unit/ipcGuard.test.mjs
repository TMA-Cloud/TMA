import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __mock, ipcMain } from 'electron';
import { useBuildConfig } from '../helpers/buildConfig.cjs';
import { freshRequire } from '../helpers/loadModule.cjs';

const SERVER_URL = 'https://cloud.example.com';
const frame = url => ({ sender: {}, senderFrame: { url } });

let guard;
beforeEach(() => {
  useBuildConfig({ serverUrl: SERVER_URL });
  delete ipcMain.__senderGuarded;
  guard = freshRequire('src/main/ipcGuard.cjs');
});

describe('IPC sender guard', () => {
  it('runs a handler called from the server origin', async () => {
    guard.installIpcSenderGuard();
    const handler = vi.fn(async () => 'ok');
    ipcMain.handle('test:channel', handler);
    await expect(__mock.invoke('test:channel', 1, frame(`${SERVER_URL}/files`))).resolves.toBe('ok');
    expect(handler).toHaveBeenCalled();
  });

  it.each([
    ['another site', 'https://evil.example/'],
    ['a look-alike host', `${SERVER_URL}.evil.example/`],
    ['an opaque data: page', 'data:text/html,hi'],
  ])('rejects a call from %s without running the handler', async (_label, url) => {
    guard.installIpcSenderGuard();
    const handler = vi.fn();
    ipcMain.handle('test:channel', handler);
    await expect(async () => __mock.invoke('test:channel', 1, frame(url))).rejects.toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a call with no sender frame at all', async () => {
    guard.installIpcSenderGuard();
    const handler = vi.fn();
    ipcMain.handle('test:channel', handler);
    await expect(async () => __mock.invoke('test:channel', 1, { sender: {} })).rejects.toThrow('Untrusted IPC sender');
    expect(handler).not.toHaveBeenCalled();
  });
});
