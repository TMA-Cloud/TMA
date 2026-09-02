/*
 * CloudDrive: mounts TMA Cloud as a Windows drive via the WinFsp host, which
 * holds no credentials and forwards each op over a local named pipe (newline
 * JSON) for us to run as an authenticated REST call. Bulk bytes go via shared
 * staging files, never the pipe. State lives on the instance so the barrel's
 * fresh require gives tests clean state; child_process.spawn is resolved at
 * call time so a test spy is picked up despite this module being cached.
 */
'use strict';

const net = require('net');
const crypto = require('crypto');
const { ipcMain, net: enet, session } = require('electron');

const { getServerUrl } = require('../config.cjs');
const { getCookieHeader } = require('../utils/file-utils.cjs');
const { log, warn } = require('./log.cjs');
const { getMode, persistMode } = require('./mode.cjs');
const { locateFsExe } = require('./locate.cjs');
const { tokenMatches } = require('./security.cjs');
const { dispatch, MAX_LINE_BYTES } = require('./dispatch.cjs');

class CloudDrive {
  constructor() {
    this._server = null;
    this._child = null;
    this._pipeName = null;
    this._authToken = null; // per-session secret the host must present on every request
    this._mountPoint = null;
    this._starting = null; // in-flight start promise
    this._sock = null; // connected fs-host pipe socket (for server→client pushes)
    this._sse = null; // backend SSE request for cache invalidation
    this._sseRetry = null;
  }

  // --------------------------- bridge pipe ---------------------------

  handleConnection(sock) {
    this._sock = sock;
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
        if (line.trim()) void this.handleLine(sock, line);
      }
    });
    sock.on('error', () => {
      /* client (fs host) went away; ignore */
    });
    sock.on('close', () => {
      if (this._sock === sock) this._sock = null;
    });
  }

  async handleLine(sock, line) {
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
    // Only our spawned host knows the per-session token; reject anything else
    // that reaches the pipe so it can't act against the signed-in account.
    if (!tokenMatches(msg.token, this._authToken)) {
      reply({ ok: false, error: 'unauthorized' });
      return;
    }
    try {
      reply({ ok: true, result: await dispatch(msg) });
    } catch (err) {
      reply({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  }

  /** Push an unsolicited cache-invalidation to the mounted filesystem host. */
  pushInvalidate(dirPath) {
    if (!this._sock) return;
    try {
      const msg = dirPath ? { push: 'invalidate', path: dirPath } : { push: 'invalidate' };
      this._sock.write(JSON.stringify(msg) + '\n');
    } catch {
      /* socket gone */
    }
  }

  /** Persist the drive mode and apply it live to a running host (no remount). */
  setMode(mode) {
    const normalized = mode === 'saveOnly' ? 'saveOnly' : 'full';
    persistMode(normalized);
    if (this._sock) {
      try {
        this._sock.write(
          JSON.stringify({ push: 'mode', mode: normalized === 'saveOnly' ? 'saveonly' : 'full' }) + '\n'
        );
      } catch {
        /* socket gone; the mode is persisted and applied on next mount */
      }
    }
    return normalized;
  }

  // --------------------------- SSE cache invalidation ---------------------------

  // Subscribe to the backend SSE stream so changes made elsewhere (web app,
  // other devices) invalidate the drive's listing cache immediately. Best-effort:
  // reconnects on drop while the drive is mounted.
  startSse() {
    const base = getServerUrl();
    if (!base) return;
    const url = `${base}/api/files/events`;

    getCookieHeader(base).then(cookieHeader => {
      if (!this._mountPoint && !this._starting) return; // drive stopped meanwhile
      const request = enet.request({ url });
      if (cookieHeader) request.setHeader('Cookie', cookieHeader);
      request.setHeader('Accept', 'text/event-stream');
      this._sse = request;

      request.on('response', response => {
        response.setEncoding('utf8');
        // Invalidate only on real change events — skip `: keepalive` and the
        // {"type":"connected"} handshake.
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
            this.pushInvalidate(); // blanket invalidate; cheap given the short TTL
          }
        });
        response.on('end', () => this.scheduleSseReconnect());
        response.on('error', () => this.scheduleSseReconnect());
      });
      request.on('error', () => this.scheduleSseReconnect());
      request.end();
    });
  }

  scheduleSseReconnect() {
    this._sse = null;
    if (!this._mountPoint) return;
    if (this._sseRetry) return;
    this._sseRetry = setTimeout(() => {
      this._sseRetry = null;
      if (this._mountPoint) this.startSse();
    }, 3000);
  }

  stopSse() {
    if (this._sseRetry) {
      clearTimeout(this._sseRetry);
      this._sseRetry = null;
    }
    if (this._sse) {
      try {
        this._sse.abort();
      } catch {
        /* ignore */
      }
      this._sse = null;
    }
  }

  // --------------------------- lifecycle ---------------------------

  /**
   * Bind the bridge pipe and spawn the WinFsp host. Resolves with the mount
   * point (e.g. "T:") once mounted. Idempotent.
   *
   * @param {object} [opts]
   * @param {string} [opts.mount="*"]  Drive letter (e.g. "T:") or "*" for next free.
   * @param {string} [opts.label="TMA Cloud"] Volume label.
   * @param {boolean} [opts.debug=false] Enable WinFsp debug logging.
   */
  startCloudDrive(opts = {}) {
    if (this._mountPoint) return Promise.resolve(this._mountPoint);
    if (this._starting) return this._starting;

    this._starting = new Promise((resolve, reject) => {
      const exe = locateFsExe();
      if (!exe) {
        this._starting = null;
        return reject(new Error('TmaCloudFs.exe not found (build desktop-fs or bundle it)'));
      }

      this._pipeName = `tma-cloud-fs-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
      this._authToken = crypto.randomBytes(24).toString('hex');
      const pipePath = `\\\\.\\pipe\\${this._pipeName}`;

      let settled = false;
      let mountTimer = null;
      const done = (err, mp) => {
        if (settled) return;
        settled = true;
        this._starting = null;
        if (mountTimer) {
          clearTimeout(mountTimer);
          mountTimer = null;
        }
        if (err) {
          // Tear down anything half-started so a failed mount leaks no host/pipe.
          this.stopSse();
          if (this._child) {
            try {
              this._child.kill();
            } catch {
              /* ignore */
            }
            this._child = null;
          }
          this.closeServer();
          this._mountPoint = null;
          this._authToken = null;
          reject(err);
        } else {
          resolve(mp);
        }
      };

      this._server = net.createServer(sock => this.handleConnection(sock));
      this._server.on('error', e => {
        warn('bridge pipe error:', e.message);
        // Reject a pre-mount bind failure, else `_starting` hangs pending forever.
        if (!this._mountPoint) done(new Error('bridge pipe error: ' + e.message));
      });

      this._server.listen(pipePath, () => {
        // A pre-mount bind error may have already rejected us before this
        // callback ran; don't spawn an orphan host after the fact.
        if (settled) return;
        const args = [
          '--pipe',
          this._pipeName,
          '--token-stdin',
          '--mount',
          opts.mount || '*',
          '--label',
          opts.label || 'TMA Cloud',
        ];
        if (getMode() === 'saveOnly') args.push('--mode', 'saveonly');
        if (opts.debug) args.push('--debug');

        log('spawning host:', exe, '--pipe', this._pipeName, '--mount', opts.mount || '*');
        const spawn = require('child_process').spawn;
        this._child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        // The bridge token goes over stdin.
        try {
          // A host that exited before reading makes this fail; the 'exit'
          // handler reports that, so there is nothing to do here.
          this._child.stdin.on('error', () => {});
          this._child.stdin.write(this._authToken + '\n');
          this._child.stdin.end();
        } catch (err) {
          warn('could not hand the token to the host:', err.message);
        }

        this._child.on('error', err => done(new Error('failed to spawn filesystem host: ' + err.message)));

        this._child.stdout.on('data', d => {
          const s = d.toString();
          for (const lineStr of s.split(/\r?\n/)) {
            if (!lineStr) continue;
            log('host:', lineStr);
            const m = lineStr.match(/^MOUNTED\s+(.+)$/);
            if (m) {
              this._mountPoint = m[1].trim();
              this.startSse(); // live cache invalidation from the backend event stream
              done(null, this._mountPoint);
            }
          }
        });
        this._child.stderr.on('data', d => warn('host:', d.toString().trim()));

        this._child.on('exit', code => {
          log('host exited, code', code);
          this._mountPoint = null;
          this._child = null;
          this.stopSse();
          this.closeServer();
          done(new Error('filesystem host exited before mounting (code ' + code + ')'));
        });

        // Safety timeout: if we never see MOUNTED, fail so callers aren't stuck.
        mountTimer = setTimeout(() => done(new Error('timed out waiting for mount')), 30000);
      });
    });

    return this._starting;
  }

  closeServer() {
    if (this._server) {
      try {
        this._server.close();
      } catch {
        /* ignore */
      }
      this._server = null;
    }
  }

  /**
   * Ask the host to unmount cleanly, then GUARANTEE it dies. We send a
   * `shutdown` push so the host runs its own OnStop() (clean unmount + staging
   * release) and exits with code 0; that path is best-effort and never replaces
   * the kill. If it hasn't exited within the grace window we TerminateProcess it
   * (child.kill()), then SIGKILL. The process is always reaped. Always resolves.
   */
  stopCloudDrive() {
    return new Promise(resolve => {
      const child = this._child;
      const sock = this._sock;
      this._mountPoint = null;
      this._authToken = null;
      this.stopSse();
      if (!child) {
        this.closeServer();
        return resolve();
      }

      let done = false;
      let graceTimer = null;
      let killTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        this.closeServer();
        resolve();
      };
      // Resolves as soon as the host process actually exits, via any path below.
      child.once('exit', finish);

      // 1) Ask for a clean stop. Pushes aren't authenticated, so this works even
      //    though we've already cleared _authToken above.
      let askedGracefully = false;
      if (sock) {
        try {
          sock.write(JSON.stringify({ push: 'shutdown' }) + '\n');
          askedGracefully = true;
        } catch {
          /* socket already gone; go straight to force-terminate */
        }
      }

      // 2) Guaranteed kill. Give the graceful stop a short window (skip it if we
      //    couldn't even send the push), then TerminateProcess, then SIGKILL.
      //    Kill the captured `child`, not `_child` (a fresh mount may replace it).
      const graceMs = askedGracefully ? 3000 : 0;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (done) return;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        killTimer = setTimeout(() => {
          killTimer = null;
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          finish();
        }, 2000);
      }, graceMs);
    });
  }

  getMountPoint() {
    return this._mountPoint;
  }

  isRunning() {
    return !!this._mountPoint;
  }

  // --------------------------- auto-mount ---------------------------

  /**
   * Auto-mount driven by the app's own auth cookie, independent of the renderer.
   * The backend sets a `token` cookie on login and clears it on logout; we watch
   * the default session and mount/unmount accordingly, so the drive appears as
   * soon as the user is signed in with no frontend cooperation.
   */
  watchAuthAndMount() {
    const base = getServerUrl();
    if (!base) {
      warn('watchAuthAndMount: no serverUrl configured; cloud drive disabled');
      return;
    }
    log('watchAuthAndMount: watching auth cookie at', base);
    const ses = session.defaultSession;

    // Re-check the ACTUAL cookie state and reconcile the mount. We never act on
    // the raw `removed` flag: Electron reports removed:true on every cookie
    // *overwrite* (e.g. a token refresh), immediately followed by the new value.
    // Debouncing + re-reading collapses the remove/add pair into one decision.
    const evaluate = async () => {
      try {
        const cookies = await ses.cookies.get({ url: base, name: 'token' });
        const signedIn = !!(cookies && cookies.length > 0);
        log('evaluate: signedIn =', signedIn, 'mounted =', this.isRunning());
        if (signedIn) {
          if (!this.isRunning()) {
            this.startCloudDrive()
              .then(mp => log('mounted at', mp))
              .catch(err => warn('auto-mount failed:', err.message));
          }
        } else if (this.isRunning()) {
          this.stopCloudDrive();
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

  // --------------------------- IPC ---------------------------

  // Lets the renderer drive the mount explicitly (the cookie watcher above is
  // the primary trigger). WinFsp must be installed for start to succeed; the
  // error is returned rather than thrown.
  registerCloudDriveHandlers() {
    ipcMain.handle('clouddrive:start', async (_event, opts) => {
      try {
        return { ok: true, mountPoint: await this.startCloudDrive(opts || {}) };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });

    ipcMain.handle('clouddrive:stop', async () => {
      try {
        await this.stopCloudDrive();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });

    ipcMain.handle('clouddrive:status', async () => ({
      running: this.isRunning(),
      mountPoint: this.getMountPoint(),
      mode: getMode(),
    }));

    ipcMain.handle('clouddrive:getMode', async () => ({ mode: getMode() }));

    ipcMain.handle('clouddrive:setMode', async (_event, mode) => {
      try {
        return { ok: true, mode: this.setMode(mode) };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });
  }
}

module.exports = { CloudDrive };
