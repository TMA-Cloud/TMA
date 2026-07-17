/*
 * Cloud Drive: mounts TMA Cloud as a Windows drive (via the WinFsp provider in
 * desktop-fs) so files can be opened and saved from any application's file
 * dialogs — the "Save As -> TMA Cloud" capability.
 *
 * This module is the trusted half of the split: the native TmaCloudFs.exe
 * performs filesystem callbacks but has no credentials; it forwards every
 * operation over a local named pipe to us, and we execute the authenticated
 * REST call using the app's existing session cookies (see file-utils.cjs).
 *
 * Protocol (newline-delimited JSON, one object per line):
 *   request:  { id, op, ...args }
 *   response: { id, ok:true, result } | { id, ok:false, error }
 * Bulk bytes travel via shared temp-file paths, never over the pipe.
 */
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, ipcMain, net: enet, session } = require('electron');

const { getServerUrl } = require('./config.cjs');

// The filesystem host stages all bulk transfers here (matches the C# host's
// Path.Combine(GetTempPath(), "tma-cloud-fs")). `src`/`dest` paths in bridge
// requests are confined to this directory so a pipe client can never make us
// read or write arbitrary files on disk.
const STAGING_DIR = path.join(os.tmpdir(), 'tma-cloud-fs');
function isInStagingDir(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  const base = path.resolve(STAGING_DIR);
  const resolved = path.resolve(p);
  return resolved === base || resolved.startsWith(base + path.sep);
}
const {
  downloadToFile,
  uploadFileToReplace,
  uploadNewFile,
  listFilesFromBackend,
  apiPostJson,
  getCookieHeader,
  getJson,
} = require('./utils/file-utils.cjs');

let _server = null;
let _child = null;
let _pipeName = null;
let _authToken = null; // per-session secret the host must present on every request
let _mountPoint = null;
let _starting = null; // in-flight start promise
let _sock = null; // the connected fs-host pipe socket (for server→client pushes)
let _sse = null; // backend SSE request for cache invalidation
let _sseRetry = null;

// Drive behavior mode, persisted per-device:
//   'full'     - normal: files can be opened/read from the drive
//   'saveOnly' - browse + Save-As only; reading file content is denied
function modeConfigPath() {
  try {
    return path.join(app.getPath('userData'), 'clouddrive-config.json');
  } catch {
    return null;
  }
}
function getMode() {
  try {
    const p = modeConfigPath();
    if (p && fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      return cfg && cfg.mode === 'saveOnly' ? 'saveOnly' : 'full';
    }
  } catch {
    /* ignore */
  }
  return 'full';
}
function persistMode(mode) {
  try {
    const p = modeConfigPath();
    if (p) fs.writeFileSync(p, JSON.stringify({ mode }));
  } catch {
    /* ignore */
  }
}

// Diagnostics: main-process console is invisible in a packaged app, so mirror
// cloud-drive logs to <userData>/clouddrive.log for troubleshooting.
let _logFile = null;
function logFilePath() {
  if (_logFile) return _logFile;
  try {
    _logFile = path.join(app.getPath('userData'), 'clouddrive.log');
  } catch {
    _logFile = null;
  }
  return _logFile;
}
function writeLog(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  const f = logFilePath();
  if (f) {
    try {
      fs.appendFileSync(f, line);
    } catch {
      /* ignore */
    }
  }
}
function log(...a) {
  console.log('[clouddrive]', ...a);
  writeLog('info', a);
}
function warn(...a) {
  console.warn('[clouddrive]', ...a);
  writeLog('warn', a);
}

/** Locate the compiled WinFsp host exe in dev and packaged layouts. */
function locateFsExe() {
  const candidates = [
    process.env.TMA_CLOUDFS_EXE,
    app && app.isPackaged ? path.join(process.resourcesPath, 'clouddrive', 'TmaCloudFs.exe') : null,
    // dev: repo-root/desktop-fs/bin/Release/TmaCloudFs.exe
    path.join(__dirname, '..', '..', '..', 'desktop-fs', 'bin', 'Release', 'TmaCloudFs.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// --------------------------- request handling ---------------------------

/** Execute one bridge request against the backend and return its result. */
async function dispatch(msg) {
  const base = getServerUrl();
  if (!base) throw new Error('server URL not configured');

  switch (msg.op) {
    case 'list':
      return listFilesFromBackend(base, msg.parentId || null);

    case 'download': {
      if (!isInStagingDir(msg.dest)) throw new Error('invalid dest path');
      const url = `${base}/api/files/${encodeURIComponent(String(msg.id))}/download`;
      await downloadToFile(url, msg.dest);
      return { ok: true };
    }

    case 'upload':
      if (!isInStagingDir(msg.src)) throw new Error('invalid src path');
      return uploadNewFile(base, msg.parentId || null, msg.src, msg.name);

    case 'replace':
      if (!isInStagingDir(msg.src)) throw new Error('invalid src path');
      await uploadFileToReplace(base, msg.id, msg.src, msg.name);
      return { ok: true };

    case 'mkdir':
      return apiPostJson(base, '/api/files/folder', {
        name: msg.name,
        parentId: msg.parentId || null,
      });

    case 'rename':
      return apiPostJson(base, '/api/files/rename', { id: msg.id, name: msg.name });

    case 'move':
      return apiPostJson(base, '/api/files/move', {
        ids: msg.ids,
        parentId: msg.parentId || null,
      });

    case 'delete':
      return apiPostJson(base, '/api/files/delete', { ids: msg.ids });

    case 'stats': {
      const cookieHeader = await getCookieHeader(base);
      return getJson(`${base}/api/user/storage`, cookieHeader); // { used, total, free }
    }

    default:
      throw new Error('unknown op: ' + msg.op);
  }
}

const MAX_LINE_BYTES = 1 << 20; // 1 MB: control messages are tiny; guard against a runaway line

function handleConnection(sock) {
  _sock = sock;
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', chunk => {
    buf += chunk;
    if (buf.length > MAX_LINE_BYTES) {
      warn('bridge line too long; dropping connection');
      sock.destroy();
      buf = '';
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) void handleLine(sock, line);
    }
  });
  sock.on('error', () => {
    /* client (fs host) went away; ignore */
  });
  sock.on('close', () => {
    if (_sock === sock) _sock = null;
  });
}

/** Push an unsolicited cache-invalidation to the mounted filesystem host. */
function pushInvalidate(dirPath) {
  if (!_sock) return;
  try {
    const msg = dirPath ? { push: 'invalidate', path: dirPath } : { push: 'invalidate' };
    _sock.write(JSON.stringify(msg) + '\n');
  } catch {
    /* socket gone */
  }
}

/** Persist the drive mode and apply it live to a running host (no remount). */
function setMode(mode) {
  const normalized = mode === 'saveOnly' ? 'saveOnly' : 'full';
  persistMode(normalized);
  if (_sock) {
    try {
      _sock.write(JSON.stringify({ push: 'mode', mode: normalized === 'saveOnly' ? 'saveonly' : 'full' }) + '\n');
    } catch {
      /* socket gone; the mode is persisted and applied on next mount */
    }
  }
  return normalized;
}

/**
 * Subscribe to the backend's Server-Sent Events stream so file changes made
 * elsewhere (web app, other devices) invalidate the drive's listing cache
 * immediately. Best-effort: reconnects on drop while the drive is mounted.
 */
function startSse() {
  const base = getServerUrl();
  if (!base) return;
  const url = `${base}/api/files/events`;

  getCookieHeader(base).then(cookieHeader => {
    if (!_mountPoint && !_starting) return; // drive stopped meanwhile
    const request = enet.request({ url });
    if (cookieHeader) request.setHeader('Cookie', cookieHeader);
    request.setHeader('Accept', 'text/event-stream');
    _sse = request;

    request.on('response', response => {
      response.setEncoding('utf8');
      // Only invalidate on real change events — skip the `: keepalive`
      // (every 30s) and the `{"type":"connected"}` handshake.
      let sseBuf = '';
      response.on('data', chunk => {
        sseBuf += chunk;
        if (sseBuf.length > MAX_LINE_BYTES) sseBuf = sseBuf.slice(-MAX_LINE_BYTES); // cap
        let idx;
        while ((idx = sseBuf.indexOf('\n')) >= 0) {
          const line = sseBuf.slice(0, idx).trim();
          sseBuf = sseBuf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let type = null;
          try {
            type = JSON.parse(payload).type;
          } catch {
            /* non-JSON: treat as a real change */
          }
          if (type === 'connected' || type === 'error') continue;
          pushInvalidate(); // blanket invalidate; cheap given the short TTL
        }
      });
      response.on('end', () => scheduleSseReconnect());
      response.on('error', () => scheduleSseReconnect());
    });
    request.on('error', () => scheduleSseReconnect());
    request.end();
  });
}

function scheduleSseReconnect() {
  _sse = null;
  if (!_mountPoint) return;
  if (_sseRetry) return;
  _sseRetry = setTimeout(() => {
    _sseRetry = null;
    if (_mountPoint) startSse();
  }, 3000);
}

function stopSse() {
  if (_sseRetry) {
    clearTimeout(_sseRetry);
    _sseRetry = null;
  }
  if (_sse) {
    try {
      _sse.abort();
    } catch {
      /* ignore */
    }
    _sse = null;
  }
}

async function handleLine(sock, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const rid = msg.rid; // RPC correlation id (distinct from any file "id" arg)
  const reply = obj => {
    try {
      sock.write(JSON.stringify({ rid, ...obj }) + '\n');
    } catch {
      /* socket closed */
    }
  };
  // Authenticate the caller: only our spawned host knows the per-session token.
  // This prevents any other local process that reaches the pipe from issuing
  // operations against the signed-in user's account.
  if (!_authToken || msg.token !== _authToken) {
    reply({ ok: false, error: 'unauthorized' });
    return;
  }
  try {
    const result = await dispatch(msg);
    reply({ ok: true, result });
  } catch (err) {
    reply({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

// --------------------------- lifecycle ---------------------------

/**
 * Start the cloud drive: bind the bridge pipe and spawn the WinFsp host.
 * Resolves with the mount point (e.g. "T:") once mounted. Idempotent.
 *
 * @param {object} [opts]
 * @param {string} [opts.mount="*"]  Drive letter (e.g. "T:") or "*" for next free.
 * @param {string} [opts.label="TMA Cloud"] Volume label.
 * @param {boolean} [opts.debug=false] Enable WinFsp debug logging.
 */
function startCloudDrive(opts = {}) {
  if (_mountPoint) return Promise.resolve(_mountPoint);
  if (_starting) return _starting;

  _starting = new Promise((resolve, reject) => {
    const exe = locateFsExe();
    if (!exe) {
      _starting = null;
      return reject(new Error('TmaCloudFs.exe not found (build desktop-fs or bundle it)'));
    }

    _pipeName = `tma-cloud-fs-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
    _authToken = crypto.randomBytes(24).toString('hex');
    const pipePath = `\\\\.\\pipe\\${_pipeName}`;

    let settled = false;
    let mountTimer = null;
    const done = (err, mp) => {
      if (settled) return;
      settled = true;
      _starting = null;
      if (mountTimer) {
        clearTimeout(mountTimer);
        mountTimer = null;
      }
      if (err) {
        // Tear down anything half-started so a failed mount leaks no host/pipe.
        stopSse();
        if (_child) {
          try {
            _child.kill();
          } catch {
            /* ignore */
          }
          _child = null;
        }
        closeServer();
        _mountPoint = null;
        _authToken = null;
        reject(err);
      } else {
        resolve(mp);
      }
    };

    _server = net.createServer(handleConnection);
    _server.on('error', e => {
      warn('bridge pipe error:', e.message);
      // Reject a pre-mount bind failure, else `_starting` hangs pending forever.
      if (!_mountPoint) done(new Error('bridge pipe error: ' + e.message));
    });

    _server.listen(pipePath, () => {
      const args = [
        '--pipe',
        _pipeName,
        '--token',
        _authToken,
        '--mount',
        opts.mount || '*',
        '--label',
        opts.label || 'TMA Cloud',
      ];
      if (getMode() === 'saveOnly') args.push('--mode', 'saveonly');
      if (opts.debug) args.push('--debug');

      // Don't log the token.
      log('spawning host:', exe, '--pipe', _pipeName, '--mount', opts.mount || '*');
      _child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      _child.on('error', err => done(new Error('failed to spawn filesystem host: ' + err.message)));

      _child.stdout.on('data', d => {
        const s = d.toString();
        for (const lineStr of s.split(/\r?\n/)) {
          if (!lineStr) continue;
          log('host:', lineStr);
          const m = lineStr.match(/^MOUNTED\s+(.+)$/);
          if (m) {
            _mountPoint = m[1].trim();
            startSse(); // live cache invalidation from the backend event stream
            done(null, _mountPoint);
          }
        }
      });
      _child.stderr.on('data', d => warn('host:', d.toString().trim()));

      _child.on('exit', code => {
        log('host exited, code', code);
        _mountPoint = null;
        _child = null;
        stopSse();
        closeServer();
        done(new Error('filesystem host exited before mounting (code ' + code + ')'));
      });

      // Safety timeout: if we never see MOUNTED, fail so callers aren't stuck.
      mountTimer = setTimeout(() => done(new Error('timed out waiting for mount')), 30000);
    });
  });

  return _starting;
}

function closeServer() {
  if (_server) {
    try {
      _server.close();
    } catch {
      /* ignore */
    }
    _server = null;
  }
}

/** Stop the cloud drive: unmount (by stopping the host) and close the pipe. */
function stopCloudDrive() {
  return new Promise(resolve => {
    const child = _child;
    _mountPoint = null;
    _authToken = null;
    stopSse();
    if (!child) {
      closeServer();
      return resolve();
    }
    let killTimer = null;
    const finish = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      closeServer();
      resolve();
    };
    child.once('exit', finish);
    try {
      // The host's Ctrl-handler / Service.Stop unmounts cleanly on terminate.
      child.kill();
    } catch {
      finish();
    }
    // Hard stop if it lingers. Kill the captured `child`, not `_child` (a fresh
    // mount may have replaced it).
    killTimer = setTimeout(() => {
      killTimer = null;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish();
    }, 5000);
  });
}

function getMountPoint() {
  return _mountPoint;
}
function isRunning() {
  return !!_mountPoint;
}

/**
 * Auto-mount driven by the app's own auth cookie, independent of the renderer.
 * The backend sets a `token` cookie on login and clears it on logout; we watch
 * the default session for it and mount/unmount accordingly. This makes the
 * drive appear as soon as the user is signed in, with no frontend cooperation
 * required (and it still works if the served frontend is an older build).
 */
function watchAuthAndMount() {
  const base = getServerUrl();
  if (!base) {
    warn('watchAuthAndMount: no serverUrl configured; cloud drive disabled');
    return;
  }
  log('watchAuthAndMount: watching auth cookie at', base);
  const ses = session.defaultSession;

  // Re-check the ACTUAL cookie state and reconcile the mount. We never act on
  // the raw `removed` flag: Electron reports removed:true on every cookie
  // *overwrite* (e.g. the backend refreshing the `token` on activity),
  // immediately followed by the new value — reacting to that would unmount the
  // drive on every token refresh. Debouncing + re-reading collapses the
  // remove/add pair into a single, correct decision.
  const evaluate = async () => {
    try {
      const cookies = await ses.cookies.get({ url: base, name: 'token' });
      const signedIn = !!(cookies && cookies.length > 0);
      log('evaluate: signedIn =', signedIn, 'mounted =', isRunning());
      if (signedIn) {
        if (!isRunning()) {
          startCloudDrive()
            .then(mp => log('mounted at', mp))
            .catch(err => warn('auto-mount failed:', err.message));
        }
      } else if (isRunning()) {
        stopCloudDrive();
      }
    } catch (err) {
      warn('auth cookie check failed:', err.message);
    }
  };

  let evalTimer = null;
  const scheduleEval = () => {
    if (evalTimer) clearTimeout(evalTimer);
    evalTimer = setTimeout(() => {
      evalTimer = null;
      void evaluate();
    }, 400);
  };

  ses.cookies.on('changed', (_event, cookie) => {
    if (cookie.name === 'token') scheduleEval();
  });

  // Handle the already-signed-in case (token persisted from a previous run).
  void evaluate();
}

/**
 * IPC surface so the renderer can also drive the mount explicitly (kept for
 * completeness; the cookie watcher above is the primary trigger). WinFsp must
 * be installed for start to succeed; the error is returned rather than thrown.
 */
function registerCloudDriveHandlers() {
  ipcMain.handle('clouddrive:start', async (_event, opts) => {
    try {
      const mountPoint = await startCloudDrive(opts || {});
      return { ok: true, mountPoint };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('clouddrive:stop', async () => {
    try {
      await stopCloudDrive();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('clouddrive:status', async () => ({
    running: isRunning(),
    mountPoint: getMountPoint(),
    mode: getMode(),
  }));

  ipcMain.handle('clouddrive:getMode', async () => ({ mode: getMode() }));

  ipcMain.handle('clouddrive:setMode', async (_event, mode) => {
    try {
      const applied = setMode(mode);
      return { ok: true, mode: applied };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

module.exports = {
  startCloudDrive,
  stopCloudDrive,
  getMountPoint,
  isRunning,
  registerCloudDriveHandlers,
  watchAuthAndMount,
};
