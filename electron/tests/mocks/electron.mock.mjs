/*
 * In-memory stand-in for the `electron` module.
 *
 * Every main-process module requires `electron` at import time, so without this
 * the suite could only run inside a real Electron runtime. The double models
 * the small slice of the API the app actually uses — app paths, ipcMain
 * registration, the net client, session cookies, dialogs and the shell — and
 * lets a test steer each one through the `__mock` handle.
 *
 * Reset between tests by tests/setup.cjs so state never leaks across files.
 */
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* --------------------------------- state --------------------------------- */

const state = {
  /** Channel -> handler registered through ipcMain.handle. */
  handlers: new Map(),
  /** Event name -> listeners registered through app.on. */
  appEvents: new Map(),
  /** Paths returned by app.getPath, keyed by name. */
  paths: {},
  appPath: path.join(__dirname, '..', '..'),
  version: '1.0.8',
  isPackaged: false,
  quitCalls: 0,
  exitCalls: [],
  singleInstanceLock: true,
  /** Ordered route table consulted by net.request / net.fetch. */
  netRoutes: [],
  /** Every request the code under test issued, in order. */
  netRequests: [],
  /** Cookies handed back by session.defaultSession.cookies.get. */
  cookies: [],
  cookieError: null,
  /** Result of the next dialog.showSaveDialog call. */
  saveDialogResult: { canceled: true, filePath: undefined },
  saveDialogCalls: [],
  /** Error string returned by shell.openPath ('' means success). */
  openPathResult: '',
  openPathCalls: [],
  clipboardText: '',
  /** When true, the first write on each request reports a full buffer. */
  backpressure: false,
  windows: [],
  permissionHandler: null,
  beforeSendHeadersHandler: null,
  applicationMenu: undefined,
};

/* ---------------------------------- net ---------------------------------- */

class FakeIncomingMessage extends EventEmitter {
  constructor({ statusCode = 200, headers = {}, body = '' }) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
    this._body = body;
    this._encoding = null;
  }

  setEncoding(enc) {
    this._encoding = enc;
  }

  // Back-pressure and teardown hooks the streaming helpers call on a response.
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  destroy() {
    this.destroyed = true;
  }

  /** Emit the canned body on the next tick, mirroring a real streamed response. */
  _flush() {
    setImmediate(() => {
      const chunks = Array.isArray(this._body) ? this._body : [this._body];
      for (const chunk of chunks) {
        this.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      this.emit('end');
    });
  }
}

class FakeClientRequest extends EventEmitter {
  constructor(options) {
    super();
    const opts = typeof options === 'string' ? { url: options } : options || {};
    this.url = opts.url;
    this.method = (opts.method || 'GET').toUpperCase();
    this.headers = { ...(opts.headers || {}) };
    this.body = [];
    this.destroyed = false;
    this._ended = false;
    state.netRequests.push(this);
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  getHeader(name) {
    return this.headers[name];
  }

  write(chunk) {
    this.body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    // Report a full buffer once when a test asked for back-pressure, then drain
    // on the next tick, which is the sequence the streaming helpers handle.
    if (state.backpressure && !this._pushedBack) {
      this._pushedBack = true;
      setImmediate(() => this.emit('drain'));
      return false;
    }
    return true;
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    if (this._ended) return;
    this._ended = true;
    setImmediate(() => {
      if (this.destroyed) return;
      const route = matchRoute(this);
      if (!route) {
        this.emit('error', new Error(`No mocked route for ${this.method} ${this.url}`));
        return;
      }
      if (route.error) {
        this.emit('error', route.error instanceof Error ? route.error : new Error(String(route.error)));
        return;
      }
      const response = new FakeIncomingMessage(route.response || {});
      this.emit('response', response);
      response._flush();
    });
  }

  destroy() {
    this.destroyed = true;
  }

  abort() {
    this.destroyed = true;
  }

  /** Concatenated request body, for asserting on multipart payloads. */
  bodyText() {
    return Buffer.concat(this.body).toString('utf8');
  }
}

function matchRoute(request) {
  for (const route of state.netRoutes) {
    if (route.method && route.method !== request.method) continue;
    if (typeof route.match === 'function') {
      if (route.match(request)) return route;
      continue;
    }
    if (route.match instanceof RegExp) {
      if (route.match.test(request.url)) return route;
      continue;
    }
    if (String(request.url).includes(String(route.match))) return route;
  }
  return null;
}

/* --------------------------------- window -------------------------------- */

class FakeWebContents extends EventEmitter {
  constructor(win) {
    super();
    this._win = win;
    this.sent = [];
    this.executed = [];
    this.session = fakeSession;
    this.executeJavaScriptResult = true;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }

  executeJavaScript(code) {
    this.executed.push(code);
    return Promise.resolve(this.executeJavaScriptResult);
  }

  /** Whatever the window loaded last, matching Electron's own semantics. */
  getURL() {
    return this._win.currentUrl() || '';
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents(this);
    this.loadedUrls = [];
    this.shown = false;
    this.destroyed = false;
    this.minimized = false;
    this.focused = false;
    this.restored = false;
    state.windows.push(this);
  }

  loadURL(url) {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }

  show() {
    this.shown = true;
  }

  focus() {
    this.focused = true;
  }

  restore() {
    this.restored = true;
  }

  isMinimized() {
    return this.minimized;
  }

  isDestroyed() {
    return this.destroyed;
  }

  /** The URL currently displayed, i.e. the most recent load. */
  currentUrl() {
    return this.loadedUrls[this.loadedUrls.length - 1];
  }
}

FakeBrowserWindow.fromWebContents = webContents => {
  const win = state.windows.find(w => w.webContents === webContents);
  return win || null;
};

/* -------------------------------- session -------------------------------- */

const cookieEmitter = new EventEmitter();

const fakeSession = {
  cookies: {
    get: async () => {
      if (state.cookieError) throw state.cookieError;
      return state.cookies.slice();
    },
    on: (event, listener) => cookieEmitter.on(event, listener),
    emitChange: (cookie, cause, removed) => cookieEmitter.emit('changed', {}, cookie, cause, removed),
  },
  webRequest: {
    onBeforeSendHeaders: (filter, handler) => {
      state.beforeSendHeadersHandler = { filter, handler };
    },
  },
  setPermissionRequestHandler: handler => {
    state.permissionHandler = handler;
  },
};

/* ---------------------------------- app ---------------------------------- */

const app = {
  getPath: name => state.paths[name] || path.join(os.tmpdir(), `tma-mock-${name}`),
  setPath: (name, value) => {
    state.paths[name] = value;
  },
  getAppPath: () => state.appPath,
  getVersion: () => {
    if (state.version instanceof Error) throw state.version;
    return state.version;
  },
  get isPackaged() {
    return state.isPackaged;
  },
  on: (event, listener) => {
    if (!state.appEvents.has(event)) state.appEvents.set(event, []);
    state.appEvents.get(event).push(listener);
    return app;
  },
  once: (event, listener) => app.on(event, listener),
  quit: () => {
    state.quitCalls += 1;
  },
  exit: code => {
    state.exitCalls.push(code);
  },
  requestSingleInstanceLock: () => state.singleInstanceLock,
  setAppUserModelId: () => {},
  whenReady: () => Promise.resolve(),
};

/* --------------------------------- exports -------------------------------- */

const electronMock = {
  app,
  BrowserWindow: FakeBrowserWindow,
  Menu: {
    setApplicationMenu: menu => {
      state.applicationMenu = menu;
    },
  },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
  },
  ipcMain: {
    handle: (channel, handler) => {
      state.handlers.set(channel, handler);
    },
    removeHandler: channel => {
      state.handlers.delete(channel);
    },
    on: () => {},
  },
  clipboard: {
    // Electron 44 aligned the clipboard module with the W3C async API: readText
    // and writeText now return Promises. Mirror that so a missing await surfaces.
    readText: async () => state.clipboardText,
    writeText: async text => {
      state.clipboardText = text;
    },
  },
  dialog: {
    showSaveDialog: async (win, options) => {
      state.saveDialogCalls.push({ win, options });
      return state.saveDialogResult;
    },
  },
  shell: {
    openPath: async target => {
      state.openPathCalls.push(target);
      return state.openPathResult;
    },
  },
  net: {
    request: options => new FakeClientRequest(options),
    fetch: async (url, init) => {
      const request = new FakeClientRequest({ url, method: (init && init.method) || 'GET' });
      const route = matchRoute(request);
      if (!route) throw new Error(`No mocked route for GET ${url}`);
      if (route.error) throw route.error instanceof Error ? route.error : new Error(String(route.error));
      return buildFetchResponse(route.response || {});
    },
  },
  session: {
    get defaultSession() {
      return fakeSession;
    },
  },
  contextBridge: {
    exposeInMainWorld: (key, value) => {
      state.exposed = { key, value };
    },
  },
  ipcRenderer: {
    invoke: (...args) => {
      state.rendererInvocations.push(args);
      return Promise.resolve(state.rendererInvokeResult);
    },
    on: (channel, listener) => {
      state.rendererListeners.push({ channel, listener });
    },
    removeListener: (channel, listener) => {
      state.rendererListeners = state.rendererListeners.filter(l => l.channel !== channel || l.listener !== listener);
    },
  },

  /** Test-only handle. Not part of the real electron surface. */
  __mock: {
    state,
    session: fakeSession,

    reset() {
      state.handlers.clear();
      state.appEvents.clear();
      state.paths = {};
      state.appPath = path.join(__dirname, '..', '..');
      state.version = '1.0.8';
      state.isPackaged = false;
      state.quitCalls = 0;
      state.exitCalls = [];
      state.singleInstanceLock = true;
      state.netRoutes = [];
      state.netRequests = [];
      state.cookies = [];
      state.cookieError = null;
      state.saveDialogResult = { canceled: true, filePath: undefined };
      state.saveDialogCalls = [];
      state.openPathResult = '';
      state.openPathCalls = [];
      state.clipboardText = '';
      state.backpressure = false;
      state.windows = [];
      state.permissionHandler = null;
      state.beforeSendHeadersHandler = null;
      state.applicationMenu = undefined;
      state.exposed = null;
      state.rendererInvocations = [];
      state.rendererListeners = [];
      state.rendererInvokeResult = undefined;
      cookieEmitter.removeAllListeners();
    },

    /** Invoke an ipcMain.handle handler as the renderer would. */
    invoke(channel, payload, event = { sender: {} }) {
      const handler = state.handlers.get(channel);
      if (!handler) throw new Error(`No IPC handler registered for "${channel}"`);
      return handler(event, payload);
    },

    hasHandler: channel => state.handlers.has(channel),
    handlerChannels: () => [...state.handlers.keys()],

    /** Fire the listeners registered through app.on for an event. */
    emitAppEvent(event, ...args) {
      const listeners = state.appEvents.get(event) || [];
      for (const listener of listeners) listener(...args);
    },

    /**
     * Queue a canned HTTP response. `match` is a substring, RegExp or predicate
     * over the request; the first matching route wins.
     */
    route(match, response, method) {
      state.netRoutes.push({ match, response, method });
    },

    /** Queue a transport-level failure for matching requests. */
    routeError(match, error, method) {
      state.netRoutes.push({ match, error, method });
    },

    requests: () => state.netRequests.slice(),
    lastRequest: () => state.netRequests[state.netRequests.length - 1],
    windows: () => state.windows.slice(),
    lastWindow: () => state.windows[state.windows.length - 1],

    setCookies(cookies) {
      state.cookies = cookies;
    },
    setCookieError(error) {
      state.cookieError = error;
    },
    setSaveDialogResult(result) {
      state.saveDialogResult = result;
    },
    setOpenPathResult(result) {
      state.openPathResult = result;
    },
    setClipboardText(text) {
      state.clipboardText = text;
    },
    /** Make outgoing requests apply back-pressure once, then drain. */
    setBackpressure(value) {
      state.backpressure = value;
    },
    setAppPath(value) {
      state.appPath = value;
    },
    setVersion(value) {
      state.version = value;
    },
    setPackaged(value) {
      state.isPackaged = value;
    },
    setSingleInstanceLock(value) {
      state.singleInstanceLock = value;
    },
  },
};

function buildFetchResponse({ statusCode = 200, headers = {}, body = '' }) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const chunks = (Array.isArray(body) ? body : [body]).map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  let index = 0;
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    statusText: statusCode === 200 ? 'OK' : 'Error',
    headers: { get: name => (lower.has(name.toLowerCase()) ? lower.get(name.toLowerCase()) : null) },
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
      }),
    },
  };
}

state.exposed = null;
state.rendererInvocations = [];
state.rendererListeners = [];
state.rendererInvokeResult = undefined;

// Named exports so `const { app } = require('electron')` inside the CommonJS
// main-process modules resolves, plus a default for ESM test files.
export { app };
export const BrowserWindow = electronMock.BrowserWindow;
export const Menu = electronMock.Menu;
export const screen = electronMock.screen;
export const ipcMain = electronMock.ipcMain;
export const clipboard = electronMock.clipboard;
export const dialog = electronMock.dialog;
export const shell = electronMock.shell;
export const net = electronMock.net;
export const session = electronMock.session;
export const contextBridge = electronMock.contextBridge;
export const ipcRenderer = electronMock.ipcRenderer;
export const __mock = electronMock.__mock;

export default electronMock;
