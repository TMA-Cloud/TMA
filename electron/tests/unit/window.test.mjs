import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';
import { createTempRoot, writeFile } from '../helpers/tempDirs.cjs';

const SERVER_URL = 'https://cloud.example.com';
const NO_SERVER_PAGE = 'data:text/html,<h1>Server URL not configured</h1>';

let createWindow;
let getMainWindow;
let preloadPath;
let appRoot;

/** Open the main window against the server URL and hand back the fake window. */
function open(loadUrl = SERVER_URL) {
  createWindow(loadUrl, preloadPath, appRoot);
  return __mock.lastWindow();
}

/** Let the window reach the point where it is shown. */
function readyToShow(win) {
  win.emit('ready-to-show');
}

beforeEach(() => {
  appRoot = createTempRoot('tma-cloud-approot-');
  preloadPath = writeFile(appRoot, 'preload.cjs', '// preload');
  ({ createWindow, getMainWindow } = freshRequire('src/main/window.cjs'));
});

describe('window security', () => {
  it('isolates the renderer: context isolation and sandbox on, node integration off', () => {
    const win = open();

    expect(win.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it('loads the preload script by absolute path', () => {
    const win = open();
    expect(path.isAbsolute(win.options.webPreferences.preload)).toBe(true);
    expect(win.options.webPreferences.preload).toBe(preloadPath);
  });

  it('resolves a relative preload path rather than passing it through', () => {
    createWindow(SERVER_URL, 'relative/preload.cjs', appRoot);
    expect(path.isAbsolute(__mock.lastWindow().options.webPreferences.preload)).toBe(true);
  });

  it('removes the application menu, which also removes its accelerators', () => {
    open();
    expect(__mock.state.applicationMenu).toBeNull();
  });

  it('blocks navigation away from the server origin', () => {
    const win = open();
    const event = { preventDefault: vi.fn() };

    win.webContents.emit('will-navigate', event, 'https://evil.example.com/login');

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('allows navigation within the server origin', () => {
    const win = open();
    const event = { preventDefault: vi.fn() };

    win.webContents.emit('will-navigate', event, `${SERVER_URL}/files/1`);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('denies every window.open call', () => {
    const win = open();
    expect(win.webContents.windowOpenHandler({ url: 'https://evil.example.com' })).toEqual({ action: 'deny' });
  });

  it('denies permission requests such as camera and microphone', () => {
    open();
    const callback = vi.fn();

    __mock.state.permissionHandler({}, 'media', callback);

    expect(callback).toHaveBeenCalledWith(false);
  });
});

describe('desktop client header', () => {
  function injectFor(url) {
    const { handler } = __mock.state.beforeSendHeadersHandler;
    const callback = vi.fn();
    handler({ url, requestHeaders: { Accept: '*/*' } }, callback);
    return callback.mock.calls[0][0].requestHeaders;
  }

  it('marks requests to the server so the backend can enforce desktop-only access', () => {
    open();
    expect(injectFor(`${SERVER_URL}/api/files`)['X-TMA-Desktop-Client']).toBe('tma-electron-client-v1');
  });

  it('subscribes with a wildcard filter and re-checks the origin itself', () => {
    open();
    expect(__mock.state.beforeSendHeadersHandler.filter).toEqual({ urls: ['<all_urls>'] });
  });

  it('never leaks the header to another origin', () => {
    open();
    expect(injectFor('https://analytics.example.com/collect')['X-TMA-Desktop-Client']).toBeUndefined();
  });

  it('never leaks the header to a host that merely starts with the server name', () => {
    open();
    expect(injectFor('https://cloud.example.com.evil.net/api')['X-TMA-Desktop-Client']).toBeUndefined();
  });

  it('leaves an unparseable URL alone instead of hanging the request', () => {
    open();
    const headers = injectFor('not-a-url');
    expect(headers).toEqual({ Accept: '*/*' });
  });

  it('always calls back, even when header building throws', () => {
    open();
    const callback = vi.fn();

    __mock.state.beforeSendHeadersHandler.handler({ url: `${SERVER_URL}/api` }, callback);

    expect(callback).toHaveBeenCalled();
  });

  it('does not install the hook for the built-in configuration page', () => {
    open(NO_SERVER_PAGE);
    expect(__mock.state.beforeSendHeadersHandler).toBeNull();
  });
});

describe('startup sequence', () => {
  it('shows a splash first so the user does not stare at a blank frame', () => {
    const win = open();
    expect(win.currentUrl().startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(win.shown).toBe(false);
  });

  it('shows the window and then loads the server once the frame is ready', async () => {
    vi.useFakeTimers();
    const win = open();

    readyToShow(win);
    expect(win.shown).toBe(true);

    vi.advanceTimersByTime(120);
    expect(win.currentUrl()).toBe(SERVER_URL);
    vi.useRealTimers();
  });

  it('loads the configuration page directly when no server is set', () => {
    const win = open(NO_SERVER_PAGE);
    readyToShow(win);

    expect(win.currentUrl()).toBe(NO_SERVER_PAGE);
    expect(win.shown).toBe(true);
  });

  it('sizes the window to a fraction of the work area rather than the whole screen', () => {
    const win = open();
    expect(win.options.width).toBe(Math.round(1920 * 0.7));
    expect(win.options.height).toBe(Math.round(1080 * 0.8));
    expect(win.options.center).toBe(true);
  });

  it('starts hidden and carries the product title', () => {
    const win = open();
    expect(win.options.show).toBe(false);
    expect(win.options.title).toBe('TMA Cloud');
  });

  it('warns instead of failing when the preload script is missing', () => {
    const warned = vi.spyOn(console, 'error').mockImplementation(() => {});

    createWindow(SERVER_URL, path.join(appRoot, 'gone.cjs'), appRoot);

    expect(warned).toHaveBeenCalled();
    expect(__mock.lastWindow()).toBeTruthy();
  });
});

describe('window icon', () => {
  it('sets no icon when none of the candidate locations has one', () => {
    const win = open();
    expect(win.options.icon).toBeUndefined();
  });

  it('falls back to the icon in the app root', () => {
    writeFile(appRoot, 'icon.png', 'PNG');
    const win = open();
    expect(win.options.icon).toBe(path.join(appRoot, 'icon.png'));
  });

  it('falls back to the icon under src/build', () => {
    const buildDir = path.join(appRoot, 'src', 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    writeFile(buildDir, 'icon.png', 'PNG');

    const win = open();

    expect(win.options.icon).toBe(path.join(buildDir, 'icon.png'));
  });
});

describe('connection failures', () => {
  it('shows a friendly page when the main frame cannot reach the server', () => {
    const win = open();

    win.webContents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', SERVER_URL, true);

    const html = decodeURIComponent(win.currentUrl().split(',')[1]);
    expect(html).toContain('Could not connect to the server');
    expect(html).toContain(SERVER_URL);
  });

  it('ignores a failure in a subframe', () => {
    const win = open();
    const before = win.currentUrl();

    win.webContents.emit('did-fail-load', {}, -106, 'ERR_FAILED', `${SERVER_URL}/iframe`, false);

    expect(win.currentUrl()).toBe(before);
  });

  it('ignores a failure for an unrelated URL, such as a background request', () => {
    const win = open();
    const before = win.currentUrl();

    win.webContents.emit('did-fail-load', {}, -106, 'ERR_FAILED', 'https://other.example.com/x', true);

    expect(win.currentUrl()).toBe(before);
  });

  it('treats a trailing slash as the same URL', () => {
    const win = open();

    win.webContents.emit('did-fail-load', {}, -106, 'ERR_FAILED', `${SERVER_URL}/`, true);

    expect(win.currentUrl()).toContain('Could%20not%20connect');
  });
});

describe('bridge probe', () => {
  it('warns when the loaded page has no desktop bridge', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = open();
    win.webContents.executeJavaScriptResult = false;

    win.webContents.emit('did-finish-load');
    await Promise.resolve();
    await Promise.resolve();

    expect(warned).toHaveBeenCalledWith(expect.stringContaining('window.electronAPI is missing'));
  });

  it('stays quiet when the bridge is present', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = open();
    win.webContents.executeJavaScriptResult = true;

    win.webContents.emit('did-finish-load');
    await Promise.resolve();
    await Promise.resolve();

    expect(warned).not.toHaveBeenCalled();
  });
});

describe('window handle', () => {
  it('hands out the live window so other modules can focus it', () => {
    const win = open();
    expect(getMainWindow()).toBe(win);
  });

  it('reports no window once it has been closed', () => {
    const win = open();
    win.emit('closed');
    expect(getMainWindow()).toBeNull();
  });

  it('starts with no window before one is created', () => {
    const { getMainWindow: fresh } = freshRequire('src/main/window.cjs');
    expect(fresh()).toBeNull();
  });
});
