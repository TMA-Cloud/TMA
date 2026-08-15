import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot, redirectTmpdir } from '../helpers/tempDirs.cjs';
import { usePlatform } from '../helpers/platform.cjs';

/** Load the entry point and let app.whenReady() resolve. */
async function startApp() {
  freshRequire('src/main/index.cjs');
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  usePlatform('win32');
  useBuildConfig({ serverUrl: SERVER_URL });
  __mock.state.paths.appData = createTempRoot('tma-cloud-appdata-');
  __mock.state.paths.userData = createTempRoot('tma-cloud-userdata-');
});

describe('startup', () => {
  it('registers every IPC channel before a window can call one', async () => {
    await startApp();

    expect(__mock.handlerChannels().sort()).toEqual([
      'app:downloadAndInstallUpdate',
      'app:getVersion',
      'clipboard:peekFileNames',
      'clipboard:readFiles',
      'clipboard:writeFiles',
      'clipboard:writeFilesFromData',
      'clipboard:writeFilesFromServer',
      'clouddrive:getMode',
      'clouddrive:setMode',
      'clouddrive:start',
      'clouddrive:status',
      'clouddrive:stop',
      'files:editWithDesktop',
      'files:saveFile',
      'files:saveFilesBulk',
    ]);
  });

  it('leaves the Windows-only cloud drive channels unregistered elsewhere', async () => {
    usePlatform('darwin');
    await startApp();

    expect(__mock.handlerChannels().filter(c => c.startsWith('clouddrive:'))).toEqual([]);
  });

  it('pins the user data directory so sign-ins survive reinstalls', async () => {
    await startApp();

    expect(__mock.state.paths.userData).toBe(path.join(__mock.state.paths.appData, 'TMA Cloud'));
  });

  it('opens the configured server in the main window', async () => {
    await startApp();
    expect(__mock.lastWindow().loadedUrls[0]).toContain('data:text/html;charset=utf-8,');
    expect(__mock.lastWindow().options.title).toBe('TMA Cloud');
  });

  it('shows the setup page when no server URL is configured', async () => {
    useBuildConfig(null);
    await startApp();

    expect(__mock.lastWindow().currentUrl()).toContain('Server URL not configured');
  });
});

describe('single instance', () => {
  it('quits immediately when another copy already holds the lock', async () => {
    __mock.setSingleInstanceLock(false);

    await startApp();

    expect(__mock.state.quitCalls).toBeGreaterThan(0);
  });

  it('focuses the existing window when a second copy is launched', async () => {
    await startApp();
    const win = __mock.lastWindow();
    win.minimized = true;

    __mock.emitAppEvent('second-instance');

    expect(win.restored).toBe(true);
    expect(win.shown).toBe(true);
    expect(win.focused).toBe(true);
  });

  it('does nothing when a second copy is launched with no window open', async () => {
    await startApp();
    __mock.lastWindow().emit('closed');

    expect(() => __mock.emitAppEvent('second-instance')).not.toThrow();
  });
});

describe('temp cleanup', () => {
  it('sweeps stale paste and edit folders on a timer', async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const tmpRoot = redirectTmpdir(vi);
    const stale = path.join(tmpRoot, 'tma-cloud-paste-old');
    fs.mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    await startApp();

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(fs.existsSync(stale)).toBe(false);
    vi.useRealTimers();
  });

  it('removes both temp trees on quit', async () => {
    const tmpRoot = redirectTmpdir(vi);
    const paste = path.join(tmpRoot, 'tma-cloud-paste-1');
    const edit = path.join(tmpRoot, 'tma-cloud-edit-1');
    fs.mkdirSync(paste, { recursive: true });
    fs.mkdirSync(edit, { recursive: true });
    // Backdate them: a folder stamped in the same millisecond as the sweep is
    // skipped, because the fractional mtime makes its age come out negative.
    const aSecondAgo = new Date(Date.now() - 1000);
    fs.utimesSync(paste, aSecondAgo, aSecondAgo);
    fs.utimesSync(edit, aSecondAgo, aSecondAgo);
    await startApp();

    __mock.emitAppEvent('before-quit', { preventDefault: () => {} });

    await vi.waitFor(() => expect(__mock.state.exitCalls).toEqual([0]));

    expect(fs.existsSync(paste)).toBe(false);
    expect(fs.existsSync(edit)).toBe(false);
  });
});

describe('quitting', () => {
  it('defers the quit so the drive can unmount, then exits', async () => {
    redirectTmpdir(vi);
    await startApp();
    const event = { preventDefault: vi.fn() };

    __mock.emitAppEvent('before-quit', event);

    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(__mock.state.exitCalls).toEqual([0]));
  });

  it('exits once even if before-quit fires again', async () => {
    redirectTmpdir(vi);
    await startApp();

    __mock.emitAppEvent('before-quit', { preventDefault: () => {} });
    __mock.emitAppEvent('before-quit', { preventDefault: () => {} });
    await vi.waitFor(() => expect(__mock.state.exitCalls).toEqual([0]));

    expect(__mock.state.exitCalls).toEqual([0]);
  });

  it('does not hold up the quit on a platform with no cloud drive', async () => {
    usePlatform('linux');
    await startApp();
    const event = { preventDefault: vi.fn() };

    __mock.emitAppEvent('before-quit', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('quits when the last window is closed', async () => {
    await startApp();
    const before = __mock.state.quitCalls;

    __mock.emitAppEvent('window-all-closed');

    expect(__mock.state.quitCalls).toBe(before + 1);
  });
});

describe('preload wiring', () => {
  it('points the window at a preload script that exists on disk', async () => {
    await startApp();
    const preload = __mock.lastWindow().options.webPreferences.preload;

    expect(fs.existsSync(preload)).toBe(true);
    expect(path.basename(preload)).toBe('index.cjs');
  });

  it('keeps the window sandboxed', async () => {
    await startApp();
    expect(__mock.lastWindow().options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
  });
});

describe('housekeeping', () => {
  it('writes nothing into the installation directory at startup', async () => {
    const electronDir = path.join(import.meta.dirname, '..', '..');
    const before = fs.readdirSync(electronDir).sort();

    await startApp();

    expect(fs.readdirSync(electronDir).sort()).toEqual(before);
  });
});
