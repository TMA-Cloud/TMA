import fs from 'fs';
import net from 'net';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __mock } from 'electron';
import { freshRequire } from '../helpers/loadModule.cjs';
import { SERVER_URL, useBuildConfig } from '../helpers/buildConfig.cjs';
import { createTempRoot, writeFile } from '../helpers/tempDirs.cjs';
import { fakeSpawn } from '../helpers/childProcess.cjs';

/** The bridge socket the filesystem host would connect with. */
class FakeSocket extends EventEmitter {
  constructor(onShutdown) {
    super();
    this.written = [];
    this.destroyed = false;
    this.onShutdown = onShutdown;
  }

  setEncoding() {}

  write(chunk) {
    this.written.push(String(chunk));
    // A real host unmounts and exits when it is asked to shut down.
    if (this.onShutdown && String(chunk).includes('"shutdown"')) setImmediate(this.onShutdown);
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  /** Every complete JSON message the main process wrote back. */
  messages() {
    return this.written
      .join('')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
}

let clouddrive;
let hosts;
let connectionHandler;
let servers;
let userData;

/** Replace the pipe server so no real named pipe is bound (and CI stays portable). */
function fakePipeServer() {
  servers = [];
  vi.spyOn(net, 'createServer').mockImplementation(handler => {
    connectionHandler = handler;
    const server = new EventEmitter();
    server.listening = false;
    server.listen = (pipePath, callback) => {
      server.pipePath = pipePath;
      server.listening = true;
      setImmediate(callback);
      return server;
    };
    server.close = () => {
      server.listening = false;
    };
    servers.push(server);
    return server;
  });
  return servers;
}

/** Start the drive and let the host report a successful mount. */
async function mount({ mountPoint = 'T:', opts } = {}) {
  const before = hosts.length;
  const promise = clouddrive.startCloudDrive(opts);
  await waitFor(() => hosts.length > before, 'the host to be spawned');
  currentHost().emitStdout(`MOUNTED ${mountPoint}\n`);
  return promise;
}

/** The host process for the current mount. */
function currentHost() {
  return hosts[hosts.length - 1];
}

/** Poll until `predicate` holds. The budget is a deadline, not an iteration
 *  count, so a fast machine does not give up before a 400ms debounce fires. */
async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Connect the host's bridge socket. By default the fake host honours a shutdown
 * push by exiting, as the real one does; pass `ignoresShutdown` to model a
 * wedged host that has to be terminated.
 */
function connect({ ignoresShutdown = false } = {}) {
  const sock = new FakeSocket(ignoresShutdown ? null : () => currentHost()?.exit(0));
  connectionHandler(sock);
  return sock;
}

/** Make every candidate location for the filesystem host look absent. */
function hideFsHost() {
  delete process.env.TMA_CLOUDFS_EXE;
  const realExists = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation(p => (String(p).endsWith('TmaCloudFs.exe') ? false : realExists(p)));
}

/** The per-session token the host was told to present. */
function hostToken() {
  return currentHost().stdinText().trim();
}

/** Send one bridge request and wait for its reply. */
async function request(sock, message) {
  const before = sock.messages().length;
  sock.emit('data', `${JSON.stringify(message)}\n`);
  await waitFor(() => sock.messages().length > before, `a reply to ${message.op}`);
  return sock.messages()[before];
}

beforeEach(() => {
  userData = createTempRoot('tma-cloud-userdata-');
  __mock.state.paths.userData = userData;
  useBuildConfig({ serverUrl: SERVER_URL });
  process.env.TMA_CLOUDFS_EXE = writeFile(createTempRoot(), 'TmaCloudFs.exe', 'MZ');
  hosts = fakeSpawn(vi);
  fakePipeServer();
  clouddrive = freshRequire('src/main/clouddrive.cjs');
  clouddrive.registerCloudDriveHandlers();
});

afterEach(async () => {
  await clouddrive.stopCloudDrive();
  delete process.env.TMA_CLOUDFS_EXE;
});

describe('drive mode', () => {
  it('defaults to save-only so file content cannot be copied off the drive', async () => {
    await expect(__mock.invoke('clouddrive:getMode')).resolves.toEqual({ mode: 'saveOnly' });
  });

  it('remembers a mode across restarts of the module', () => {
    clouddrive.registerCloudDriveHandlers();
    __mock.invoke('clouddrive:setMode', 'full');

    const reloaded = freshRequire('src/main/clouddrive.cjs');
    reloaded.registerCloudDriveHandlers();

    return expect(__mock.invoke('clouddrive:getMode')).resolves.toEqual({ mode: 'full' });
  });

  it('treats any value other than saveOnly as full', async () => {
    clouddrive.registerCloudDriveHandlers();
    await expect(__mock.invoke('clouddrive:setMode', 'nonsense')).resolves.toEqual({ ok: true, mode: 'full' });
    await expect(__mock.invoke('clouddrive:setMode', 'saveOnly')).resolves.toEqual({ ok: true, mode: 'saveOnly' });
  });

  it('falls back to save-only when the stored config is corrupt', async () => {
    fs.writeFileSync(path.join(userData, 'clouddrive-config.json'), '{ broken');
    const reloaded = freshRequire('src/main/clouddrive.cjs');
    reloaded.registerCloudDriveHandlers();

    await expect(__mock.invoke('clouddrive:getMode')).resolves.toEqual({ mode: 'saveOnly' });
  });

  it('applies a mode change to the running host without remounting', async () => {
    clouddrive.registerCloudDriveHandlers();
    await mount();
    const sock = connect();

    await __mock.invoke('clouddrive:setMode', 'full');

    expect(sock.messages()).toContainEqual({ push: 'mode', mode: 'full' });
    expect(hosts).toHaveLength(1);
  });

  it('sends the host the lowercase form it expects for save-only', async () => {
    clouddrive.registerCloudDriveHandlers();
    await mount();
    const sock = connect();

    await __mock.invoke('clouddrive:setMode', 'saveOnly');

    expect(sock.messages()).toContainEqual({ push: 'mode', mode: 'saveonly' });
  });
});

describe('starting the drive', () => {
  it('spawns the host with the pipe, mount point and label', async () => {
    const mountPoint = await mount({ opts: { mount: 'Z:', label: 'My Cloud' } });

    expect(mountPoint).toBe('T:');
    expect(hosts[0].args).toEqual(
      expect.arrayContaining(['--pipe', '--token-stdin', '--mount', 'Z:', '--label', 'My Cloud', '--mode', 'saveonly'])
    );
  });

  it('hands the token to the host on stdin, never on the command line', async () => {
    await mount();

    // A command line is readable by any process running as this user, and the
    // token alone is enough to drive the account through the bridge.
    expect(hosts[0].args).not.toContain('--token');
    expect(hosts[0].args.join(' ')).not.toContain(hostToken());
    expect(hosts[0].stdinText()).toBe(hostToken() + '\n');
    expect(hosts[0].stdinEnded).toBe(true);
  });

  it('gives the host a writable stdin to receive the token on', async () => {
    await mount();
    expect(hosts[0].options.stdio[0]).toBe('pipe');
  });

  it('lets Windows choose the drive letter by default', async () => {
    await mount();
    expect(hosts[0].args[hosts[0].args.indexOf('--mount') + 1]).toBe('*');
    expect(hosts[0].args[hosts[0].args.indexOf('--label') + 1]).toBe('TMA Cloud');
  });

  it('omits the save-only flag when the drive is in full mode', async () => {
    clouddrive.registerCloudDriveHandlers();
    await __mock.invoke('clouddrive:setMode', 'full');

    await mount();

    expect(hosts[0].args).not.toContain('--mode');
  });

  it('gives each session a fresh pipe name and token', async () => {
    await mount();
    const firstToken = hostToken();
    const firstPipe = servers[0].pipePath;
    await clouddrive.stopCloudDrive();

    await mount();

    expect(hostToken()).not.toBe(firstToken);
    expect(servers[1].pipePath).not.toBe(firstPipe);
  });

  it('binds the pipe under the Windows named-pipe namespace', async () => {
    await mount();
    expect(servers[0].pipePath.startsWith('\\\\.\\pipe\\tma-cloud-fs-')).toBe(true);
  });

  it('is idempotent while the drive is already mounted', async () => {
    await mount();
    await expect(clouddrive.startCloudDrive()).resolves.toBe('T:');
    expect(hosts).toHaveLength(1);
  });

  it('shares one in-flight start between concurrent callers', async () => {
    const first = clouddrive.startCloudDrive();
    const second = clouddrive.startCloudDrive();
    await waitFor(() => hosts.length === 1, 'the host to be spawned');
    hosts[0].emitStdout('MOUNTED T:\n');

    await expect(Promise.all([first, second])).resolves.toEqual(['T:', 'T:']);
    expect(hosts).toHaveLength(1);
  });

  it('fails clearly when the filesystem host is not bundled', async () => {
    hideFsHost();
    const reloaded = freshRequire('src/main/clouddrive.cjs');

    await expect(reloaded.startCloudDrive()).rejects.toThrow(/TmaCloudFs\.exe not found/);
  });

  it('fails when the host cannot be launched', async () => {
    const promise = clouddrive.startCloudDrive();
    await waitFor(() => hosts.length === 1, 'the host to be spawned');
    hosts[0].emit('error', new Error('EACCES'));

    await expect(promise).rejects.toThrow(/failed to spawn filesystem host/);
  });

  it('fails when the host exits before reporting a mount', async () => {
    const promise = clouddrive.startCloudDrive();
    await waitFor(() => hosts.length === 1, 'the host to be spawned');
    hosts[0].exit(3);

    await expect(promise).rejects.toThrow(/exited before mounting \(code 3\)/);
    expect(clouddrive.isRunning()).toBe(false);
  });

  it('fails instead of hanging when the pipe cannot be bound', async () => {
    const promise = clouddrive.startCloudDrive();
    await waitFor(() => servers.length === 1, 'the pipe server');
    servers[0].emit('error', new Error('EADDRINUSE'));

    await expect(promise).rejects.toThrow(/bridge pipe error/);
  });

  it('gives up if the host never reports a mount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const promise = clouddrive.startCloudDrive();
    await waitFor(() => hosts.length === 1, 'the host to be spawned');

    vi.advanceTimersByTime(30000);

    await expect(promise).rejects.toThrow(/timed out waiting for mount/);
    vi.useRealTimers();
  });

  it('reports the mount point and running state through IPC', async () => {
    clouddrive.registerCloudDriveHandlers();
    await mount();

    await expect(__mock.invoke('clouddrive:status')).resolves.toEqual({
      running: true,
      mountPoint: 'T:',
      mode: 'saveOnly',
    });
  });

  it('returns the start error to the renderer rather than throwing', async () => {
    hideFsHost();
    const reloaded = freshRequire('src/main/clouddrive.cjs');
    reloaded.registerCloudDriveHandlers();

    const result = await __mock.invoke('clouddrive:start', {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/TmaCloudFs\.exe not found/);
  });

  it('writes a log file so a packaged app can be diagnosed', async () => {
    await mount();
    expect(fs.existsSync(path.join(userData, 'clouddrive.log'))).toBe(true);
  });

  it('never writes the session token to the log', async () => {
    await mount();
    const log = fs.readFileSync(path.join(userData, 'clouddrive.log'), 'utf8');
    expect(log).not.toContain(hostToken());
  });
});

describe('bridge authentication', () => {
  beforeEach(async () => {
    await mount();
  });

  it('refuses a request with no token', async () => {
    const sock = connect();
    await expect(request(sock, { rid: 1, op: 'list' })).resolves.toEqual({ rid: 1, ok: false, error: 'unauthorized' });
  });

  it('refuses a request with the wrong token', async () => {
    const sock = connect();
    const reply = await request(sock, { rid: 1, op: 'list', token: 'guessed' });
    expect(reply).toEqual({ rid: 1, ok: false, error: 'unauthorized' });
  });

  it('refuses a non-string token instead of throwing', async () => {
    const sock = connect();
    for (const token of [null, 42, ['x'], { toString: () => hostToken() }]) {
      await expect(request(sock, { rid: 1, op: 'list', token })).resolves.toMatchObject({
        error: 'unauthorized',
      });
    }
  });

  it('never reaches the backend for an unauthorised request', async () => {
    const sock = connect();
    await request(sock, { rid: 1, op: 'delete', token: 'guessed', ids: ['1'] });
    expect(__mock.requests().filter(r => r.url.includes('/api/files/delete'))).toHaveLength(0);
  });

  it('refuses everything again once the drive has stopped', async () => {
    const sock = connect();
    const token = hostToken();
    await clouddrive.stopCloudDrive();

    await expect(request(sock, { rid: 1, op: 'list', token })).resolves.toMatchObject({ error: 'unauthorized' });
  });
});

describe('bridge operations', () => {
  let sock;
  let token;

  beforeEach(async () => {
    await mount();
    sock = connect();
    token = hostToken();
  });

  const call = message => request(sock, { rid: 1, token, ...message });

  it('lists a folder through the files API', async () => {
    __mock.route('/api/files', { statusCode: 200, body: '[{"id":"1"}]' });

    const reply = await call({ op: 'list', parentId: 'folder-1' });

    expect(reply).toEqual({ rid: 1, ok: true, result: [{ id: '1' }] });
    expect(__mock.lastRequest().url).toBe(`${SERVER_URL}/api/files?parentId=folder-1`);
  });

  it('creates a folder', async () => {
    __mock.route('/api/files/folder', { statusCode: 200, body: '{"id":"f1"}' });

    await call({ op: 'mkdir', name: 'New folder', parentId: 'p1' });

    expect(JSON.parse(__mock.lastRequest().bodyText())).toEqual({ name: 'New folder', parentId: 'p1' });
  });

  it('renames, moves and deletes through their endpoints', async () => {
    __mock.route('/api/files/rename', { statusCode: 200, body: '{}' });
    __mock.route('/api/files/move', { statusCode: 200, body: '{}' });
    __mock.route('/api/files/delete', { statusCode: 200, body: '{}' });

    await call({ op: 'rename', id: '1', name: 'b.txt' });
    expect(JSON.parse(__mock.lastRequest().bodyText())).toEqual({ id: '1', name: 'b.txt' });

    await call({ op: 'move', ids: ['1'], parentId: 'p2' });
    expect(JSON.parse(__mock.lastRequest().bodyText())).toEqual({ ids: ['1'], parentId: 'p2' });

    await call({ op: 'delete', ids: ['1', '2'] });
    expect(JSON.parse(__mock.lastRequest().bodyText())).toEqual({ ids: ['1', '2'] });
  });

  it('reports storage usage for the drive properties dialog', async () => {
    __mock.route('/api/user/storage', { statusCode: 200, body: '{"used":1,"total":2,"free":1}' });

    const reply = await call({ op: 'stats' });

    expect(reply.result).toEqual({ used: 1, total: 2, free: 1 });
  });

  it('downloads a file into the staging directory', async () => {
    const dest = path.join(__mock.state.paths.temp || require('os').tmpdir(), 'tma-cloud-fs', 'file-1');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    __mock.route('/download', { statusCode: 200, body: 'DATA' });

    const reply = await call({ op: 'download', id: '1', dest });

    expect(reply).toEqual({ rid: 1, ok: true, result: { ok: true } });
    expect(fs.readFileSync(dest, 'utf8')).toBe('DATA');
  });

  it('refuses to write a download outside the staging directory', async () => {
    const outside = path.join(createTempRoot(), 'stolen.txt');

    const reply = await call({ op: 'download', id: '1', dest: outside });

    expect(reply).toEqual({ rid: 1, ok: false, error: 'invalid dest path' });
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('refuses a download path that tries to climb out of staging', async () => {
    const traversal = path.join(require('os').tmpdir(), 'tma-cloud-fs', '..', '..', 'evil.txt');

    await expect(call({ op: 'download', id: '1', dest: traversal })).resolves.toMatchObject({
      error: 'invalid dest path',
    });
  });

  it('refuses a sibling directory whose name merely starts with the staging path', async () => {
    const sibling = path.join(require('os').tmpdir(), 'tma-cloud-fs-evil', 'x.txt');

    await expect(call({ op: 'download', id: '1', dest: sibling })).resolves.toMatchObject({
      error: 'invalid dest path',
    });
  });

  it('uploads a staged file as a new cloud file', async () => {
    const src = path.join(require('os').tmpdir(), 'tma-cloud-fs', 'upload-1');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'NEW');
    __mock.route('/api/files/upload', { statusCode: 200, body: '{"id":"new"}' });

    const reply = await call({ op: 'upload', src, name: 'note.txt', parentId: 'p1' });

    expect(reply.result).toEqual({ id: 'new' });
    expect(__mock.lastRequest().bodyText()).toContain('NEW');
  });

  it('refuses an upload sourced from outside the staging directory', async () => {
    const src = writeFile(createTempRoot(), 'secret.txt', 'SECRET');

    const reply = await call({ op: 'upload', src, name: 'secret.txt' });

    expect(reply).toEqual({ rid: 1, ok: false, error: 'invalid src path' });
    expect(__mock.requests().filter(r => r.url.includes('/upload'))).toHaveLength(0);
  });

  it('refuses a replace sourced from outside the staging directory', async () => {
    const src = writeFile(createTempRoot(), 'secret.txt', 'SECRET');

    await expect(call({ op: 'replace', id: '1', src, name: 'secret.txt' })).resolves.toEqual({
      rid: 1,
      ok: false,
      error: 'invalid src path',
    });
  });

  it('rejects an unknown operation', async () => {
    await expect(call({ op: 'exec' })).resolves.toEqual({ rid: 1, ok: false, error: 'unknown op: exec' });
  });

  it('passes a backend failure back to the host', async () => {
    __mock.route('/api/files/rename', { statusCode: 409, body: 'name taken' });

    const reply = await call({ op: 'rename', id: '1', name: 'b.txt' });

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('409');
  });

  it('answers each request with the id it came in on', async () => {
    __mock.route('/api/files', { statusCode: 200, body: '[]' });

    sock.emit('data', `${JSON.stringify({ rid: 7, token, op: 'list' })}\n`);
    await waitFor(() => sock.messages().length === 1, 'the reply');

    expect(sock.messages()[0].rid).toBe(7);
  });
});

describe('bridge framing', () => {
  let sock;
  let token;

  beforeEach(async () => {
    await mount();
    sock = connect();
    token = hostToken();
  });

  it('handles several requests arriving in one chunk', async () => {
    __mock.route('/api/files', { statusCode: 200, body: '[]' });

    sock.emit(
      'data',
      `${JSON.stringify({ rid: 1, token, op: 'list' })}\n${JSON.stringify({ rid: 2, token, op: 'list' })}\n`
    );
    await waitFor(() => sock.messages().length === 2, 'both replies');

    expect(
      sock
        .messages()
        .map(m => m.rid)
        .sort()
    ).toEqual([1, 2]);
  });

  it('handles a request split across chunks', async () => {
    __mock.route('/api/files', { statusCode: 200, body: '[]' });
    const line = JSON.stringify({ rid: 1, token, op: 'list' });

    sock.emit('data', line.slice(0, 10));
    sock.emit('data', `${line.slice(10)}\n`);
    await waitFor(() => sock.messages().length === 1, 'the reply');

    expect(sock.messages()[0].ok).toBe(true);
  });

  it('ignores a line that is not JSON', async () => {
    sock.emit('data', 'not json\n');
    sock.emit('data', `${JSON.stringify({ rid: 1, token, op: 'stats' })}\n`);
    __mock.route('/api/user/storage', { statusCode: 200, body: '{}' });

    await waitFor(() => sock.messages().length === 1, 'the reply to the valid line');
    expect(sock.messages()[0].rid).toBe(1);
  });

  it('drops a connection that floods the bridge with one huge line', () => {
    sock.emit('data', 'x'.repeat(1024 * 1024 + 1));
    expect(sock.destroyed).toBe(true);
  });

  it('survives a socket error without taking the process down', () => {
    expect(() => sock.emit('error', new Error('EPIPE'))).not.toThrow();
  });
});

describe('live invalidation from the backend', () => {
  it('tells the host to drop its cache when a change event arrives', async () => {
    __mock.route('/api/files/events', {
      statusCode: 200,
      body: 'data: {"type":"connected"}\n\ndata: {"type":"file.created"}\n\n',
    });
    await mount();
    const sock = connect();

    await waitFor(() => sock.messages().length > 0, 'an invalidation push');

    expect(sock.messages()).toEqual([{ push: 'invalidate' }]);
  });

  it('ignores the handshake and keepalive lines', async () => {
    __mock.route('/api/files/events', {
      statusCode: 200,
      body: ': keepalive\n\ndata: {"type":"connected"}\n\ndata: {"type":"error"}\n\n',
    });
    await mount();
    const sock = connect();
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(sock.messages()).toEqual([]);
  });

  it('subscribes with the session cookies', async () => {
    __mock.setCookies([{ name: 'token', value: 'abc' }]);
    __mock.route('/api/files/events', { statusCode: 200, body: '' });

    await mount();
    await waitFor(() => __mock.requests().some(r => r.url.endsWith('/api/files/events')), 'the event stream request');

    const sse = __mock.requests().find(r => r.url.endsWith('/api/files/events'));
    expect(sse.headers.Cookie).toBe('token=abc');
    expect(sse.headers.Accept).toBe('text/event-stream');
  });
});

describe('stopping the drive', () => {
  it('asks the host to unmount cleanly before killing it', async () => {
    await mount();
    const sock = connect();

    const stopping = clouddrive.stopCloudDrive();
    await waitFor(() => sock.messages().length > 0, 'the shutdown push');
    expect(sock.messages()).toContainEqual({ push: 'shutdown' });

    hosts[0].exit(0);
    await stopping;
    expect(clouddrive.isRunning()).toBe(false);
  });

  it('force-terminates a host that ignores the shutdown request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await mount();
    connect({ ignoresShutdown: true });

    const stopping = clouddrive.stopCloudDrive();
    vi.advanceTimersByTime(3000);
    expect(hosts[0].killed).toBe(true);

    vi.advanceTimersByTime(2000);
    await stopping;
    expect(hosts[0].killSignals).toContain('SIGKILL');
    vi.useRealTimers();
  });

  it('resolves immediately when nothing is mounted', async () => {
    await expect(clouddrive.stopCloudDrive()).resolves.toBeUndefined();
  });

  it('clears the mount point so a later start is a fresh mount', async () => {
    await mount();
    const stopping = clouddrive.stopCloudDrive();
    hosts[0].exit(0);
    await stopping;

    expect(clouddrive.getMountPoint()).toBeNull();
    await expect(mount()).resolves.toBe('T:');
    expect(hosts).toHaveLength(2);
  });

  it('reports success to the renderer', async () => {
    clouddrive.registerCloudDriveHandlers();
    await mount();
    const stopping = __mock.invoke('clouddrive:stop');
    hosts[0].exit(0);

    await expect(stopping).resolves.toEqual({ ok: true });
  });
});

describe('auto-mount from the auth cookie', () => {
  it('does nothing when no server URL is configured', () => {
    useBuildConfig(null);
    clouddrive.watchAuthAndMount();
    expect(hosts).toHaveLength(0);
  });

  it('mounts when the app is already signed in at startup', async () => {
    __mock.setCookies([{ name: 'token', value: 'abc' }]);

    clouddrive.watchAuthAndMount();
    await waitFor(() => hosts.length === 1, 'the host to be spawned');
    hosts[0].emitStdout('MOUNTED T:\n');

    await waitFor(() => clouddrive.isRunning(), 'the drive to report mounted');
  });

  it('stays unmounted while signed out', async () => {
    __mock.setCookies([]);
    clouddrive.watchAuthAndMount();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(hosts).toHaveLength(0);
  });

  it('mounts after a login sets the token cookie', async () => {
    __mock.setCookies([]);
    clouddrive.watchAuthAndMount();
    await new Promise(resolve => setTimeout(resolve, 20));

    __mock.setCookies([{ name: 'token', value: 'abc' }]);
    __mock.session.cookies.emitChange({ name: 'token' }, 'explicit', false);

    await waitFor(() => hosts.length === 1, 'the host to be spawned');
  });

  it('ignores changes to unrelated cookies', async () => {
    __mock.setCookies([]);
    clouddrive.watchAuthAndMount();
    __mock.setCookies([{ name: 'token', value: 'abc' }]);
    __mock.session.cookies.emitChange({ name: 'theme' }, 'explicit', false);
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(hosts).toHaveLength(0);
  });

  it('does not unmount on a token refresh, which arrives as a remove then an add', async () => {
    __mock.setCookies([{ name: 'token', value: 'abc' }]);
    clouddrive.watchAuthAndMount();
    await waitFor(() => hosts.length === 1, 'the host to be spawned');
    hosts[0].emitStdout('MOUNTED T:\n');
    await waitFor(() => clouddrive.isRunning(), 'the drive to report mounted');

    // Electron reports removed:true for the overwrite, then the new value.
    __mock.session.cookies.emitChange({ name: 'token' }, 'overwrite', true);
    __mock.setCookies([{ name: 'token', value: 'refreshed' }]);
    __mock.session.cookies.emitChange({ name: 'token' }, 'explicit', false);
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(clouddrive.isRunning()).toBe(true);
    expect(hosts[0].killed).toBe(false);
  });

  it('unmounts when the session is signed out', async () => {
    __mock.setCookies([{ name: 'token', value: 'abc' }]);
    clouddrive.watchAuthAndMount();
    await waitFor(() => hosts.length === 1, 'the host to be spawned');
    hosts[0].emitStdout('MOUNTED T:\n');
    await waitFor(() => clouddrive.isRunning(), 'the drive to report mounted');

    __mock.setCookies([]);
    __mock.session.cookies.emitChange({ name: 'token' }, 'explicit', true);

    await waitFor(() => !clouddrive.isRunning(), 'the drive to unmount');
  });
});
