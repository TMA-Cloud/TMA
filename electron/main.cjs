const { app, BrowserWindow, ipcMain, Menu, net, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const EMBEDDED_SERVER_URL = '';

/**
 * Escape a path for safe use inside a PowerShell single-quoted string (e.g. -LiteralPath '...').
 * In single-quoted strings only ' is special; escape as ''.
 * Control chars (newline, CR, null) are stripped so the path cannot break script or line-based parsing.
 * Use this for any path interpolated into a PowerShell -Command script.
 */
function escapePathForPowerShellLiteralPath(pathStr) {
  if (pathStr == null || typeof pathStr !== 'string') return '';
  return pathStr.replace(/\r\n|\r|\n|\0/g, '').replace(/'/g, "''");
}

/** Run a PowerShell script without shell (avoids Node DEP0190). Returns promise with stdout string. */
function runPowerShell(script, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn('powershell', ['-NoProfile', '-Command', script], {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += d.toString();
    });
    child.stderr.on('data', d => {
      stderr += d.toString();
    });
    const t = setTimeout(() => {
      child.kill();
      reject(new Error('Timeout'));
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(stdout);
    });
    child.on('error', reject);
  });
}

function getServerUrl() {
  if (EMBEDDED_SERVER_URL) return EMBEDDED_SERVER_URL;
  const buildConfigPath = path.join(__dirname, 'configs', 'build-config.json');
  if (fs.existsSync(buildConfigPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(buildConfigPath, 'utf8'));
      if (data.serverUrl) return data.serverUrl;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

const NO_SERVER_URL_PAGE =
  'data:text/html,<h1>Server URL not configured</h1><p>Run from source with <code>configs/build-config.json</code></p>';

const LOADING_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc}.c{text-align:center}.t{font-size:1.5rem;font-weight:600;letter-spacing:-.02em}.b{height:2px;width:80px;margin:20px auto 0;background:rgba(148,163,184,.2);border-radius:1px;overflow:hidden}.b::after{content:"";display:block;height:100%;width:40%;background:#3b82f6;border-radius:1px;animation:p .6s ease-in-out infinite}@keyframes p{0%,100%{transform:translateX(-100%)}50%{transform:translateX(150%)}}</style></head><body><div class="c"><div class="t">TMA Cloud</div><div class="b"></div></div></body></html>'
  );

function serverErrorPage(serverUrl) {
  const u = serverUrl.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#1a1a2e;color:#e4e4e7;} .box{text-align:center;max-width:420px;padding:2rem;} h1{font-size:1.25rem;font-weight:600;margin:0 0 0.75rem;} p{margin:0;color:#a1a1aa;font-size:0.9375rem;line-height:1.5;} a{color:#60a5fa;}</style></head><body>' +
      '<div class="box"><h1>Could not connect to the server</h1>' +
      '<p>Check that your network is working and the server is running at <strong>' +
      u +
      '</strong></p>' +
      '<p style="margin-top:1rem;">You can try again by closing and reopening the app, or contact your administrator.</p></div></body></html>'
  )}`;
}

function createWindow(loadUrl) {
  const iconInApp = path.join(__dirname, 'icon.png');
  const iconInBuild = path.join(__dirname, 'build', 'icon.png');
  const iconPath = fs.existsSync(iconInApp) ? iconInApp : fs.existsSync(iconInBuild) ? iconInBuild : null;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'TMA Cloud',
    show: false,
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);

  const isServerUrl = loadUrl && !loadUrl.startsWith('data:');

  if (isServerUrl) {
    win.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      const a = (loadUrl || '').replace(/\/$/, '');
      const b = (validatedURL || '').replace(/\/$/, '');
      if (a !== b && b.indexOf(a) !== 0 && a.indexOf(b) !== 0) return;
      win.loadURL(serverErrorPage(loadUrl));
    });
  }

  if (isServerUrl) {
    win.loadURL(LOADING_PAGE);
    win.once('ready-to-show', () => {
      win.show();
      setTimeout(() => win.loadURL(loadUrl), 120);
    });
  } else {
    win.loadURL(loadUrl);
    win.once('ready-to-show', () => win.show());
  }
}

ipcMain.handle('clipboard:readFiles', async () => {
  if (process.platform !== 'win32') return { files: [] };
  try {
    const stdout = await runPowerShell(
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }'
    );
    const paths = stdout
      .split(/\r?\n/)
      .map(p => p.trim())
      .filter(Boolean);
    if (paths.length === 0) return { files: [] };
    const files = [];
    for (const p of paths) {
      try {
        const stat = fs.statSync(p);
        if (!stat.isFile()) continue;
        const buf = fs.readFileSync(p);
        const name = path.basename(p);
        const ext = path.extname(name).toLowerCase();
        const mime =
          {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }[ext] || 'application/octet-stream';
        files.push({ name, mime, data: buf.toString('base64') });
      } catch (_) {
        // ignore
      }
    }
    return { files };
  } catch (_) {
    return { files: [] };
  }
});

ipcMain.handle('clipboard:writeFiles', async (_event, paths) => {
  if (process.platform !== 'win32' || !Array.isArray(paths) || paths.length === 0) {
    return { ok: false };
  }
  const safePaths = paths.filter(p => typeof p === 'string' && p.length > 0 && !/[\r\n\0]/.test(p));
  if (safePaths.length === 0) return { ok: false };
  const tmp = path.join(os.tmpdir(), `electron-desktop-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmp, safePaths.join('\n'), 'utf8');
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $col = New-Object System.Collections.Specialized.StringCollection; Get-Content -Encoding UTF8 -LiteralPath '${escapePathForPowerShellLiteralPath(tmp)}' | ForEach-Object { $col.Add($_) }; [System.Windows.Forms.Clipboard]::SetFileDropList($col)`;
    await runPowerShell(ps);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      // ignore
    }
  }
});

const PASTE_DIR_PREFIX = 'tma-cloud-paste-';
const EDIT_DIR_PREFIX = 'tma-cloud-edit-';

function sanitizeFileName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'file';
}

function createTempDir(prefix) {
  const tmpRoot = os.tmpdir();
  const dir = path.join(tmpRoot, `${prefix}${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadToFile(url, filePath) {
  let cookieHeader = '';
  try {
    const cookies = await session.defaultSession.cookies.get({ url });
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    cookieHeader = '';
  }

  return new Promise((resolve, reject) => {
    const request = net.request({ url });
    if (cookieHeader) {
      request.setHeader('Cookie', cookieHeader);
    }
    request.on('response', response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const status = response.statusCode || 0;
        let body = '';
        response.on('data', chunk => {
          if (body.length < 4096) {
            body += chunk.toString('utf8');
          }
        });
        response.on('end', () => {
          reject(new Error(body ? `Download failed (${status}): ${body}` : `Download failed (${status})`));
        });
        response.on('error', reject);
        return;
      }

      const fileStream = fs.createWriteStream(filePath);

      response.on('data', chunk => {
        fileStream.write(chunk);
      });

      response.on('end', () => {
        fileStream.end(() => resolve());
      });

      response.on('error', err => {
        fileStream.destroy();
        reject(err);
      });

      fileStream.on('error', err => {
        response.destroy();
        reject(err);
      });
    });

    request.on('error', reject);
    request.end();
  });
}

function setClipboardToPaths(writtenPaths) {
  const safePaths = (writtenPaths || []).filter(p => typeof p === 'string' && p.length > 0 && !/[\r\n\0]/.test(p));
  if (safePaths.length === 0) return Promise.resolve();
  const tmpRoot = os.tmpdir();
  const tmp = path.join(tmpRoot, `electron-desktop-${Date.now()}.txt`);
  fs.writeFileSync(tmp, safePaths.join('\n'), 'utf8');
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $col = New-Object System.Collections.Specialized.StringCollection; Get-Content -Encoding UTF8 -LiteralPath '${escapePathForPowerShellLiteralPath(tmp)}' | ForEach-Object { $col.Add($_) }; [System.Windows.Forms.Clipboard]::SetFileDropList($col)`;
  return runPowerShell(ps).then(() => {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
  });
}

function cleanTempDirsByPrefix(prefix, maxAgeMs) {
  const tmpRoot = os.tmpdir();
  const now = Date.now();
  try {
    const existing = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const e of existing) {
      if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
      const dirPath = path.join(tmpRoot, e.name);
      try {
        const stat = fs.statSync(dirPath);
        const age = now - stat.mtimeMs;
        if (age >= maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function uploadFileToReplace(base, fileId, filePath, fileName) {
  const url = `${base}/api/files/${encodeURIComponent(fileId)}/replace`;

  let cookieHeader = '';
  try {
    const cookies = await session.defaultSession.cookies.get({ url: base });
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch {
    cookieHeader = '';
  }

  const boundary = `----ElectronFormBoundary${crypto.randomBytes(16).toString('hex')}`;
  const dispositionName = 'file';
  const safeFileName = String(fileName).replace(/"/g, '\\"');

  const preamble =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${dispositionName}"; filename="${safeFileName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const closing = `\r\n--${boundary}--\r\n`;

  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
    if (cookieHeader) {
      request.setHeader('Cookie', cookieHeader);
    }

    request.on('response', response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const status = response.statusCode || 0;
        let body = '';
        response.on('data', chunk => {
          if (body.length < 4096) {
            body += chunk.toString('utf8');
          }
        });
        response.on('end', () => {
          reject(new Error(body ? `Upload failed (${status}): ${body}` : `Upload failed (${status})`));
        });
        response.on('error', reject);
        return;
      }

      // Consume response and resolve
      response.on('data', () => {});
      response.on('end', () => resolve());
      response.on('error', reject);
    });

    request.on('error', reject);

    request.write(preamble);

    const fileStream = fs.createReadStream(filePath);
    fileStream.on('data', chunk => {
      request.write(chunk);
    });
    fileStream.on('end', () => {
      request.write(closing);
      request.end();
    });
    fileStream.on('error', err => {
      request.destroy();
      reject(err);
    });
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', chunk => {
      hash.update(chunk);
    });

    stream.on('error', err => {
      reject(err);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

ipcMain.handle('clipboard:writeFilesFromData', async (_event, payload) => {
  if (process.platform !== 'win32' || !payload?.files?.length) {
    return { ok: false, error: 'Invalid payload' };
  }
  const tmpRoot = os.tmpdir();
  try {
    const existing = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const e of existing) {
      if (e.isDirectory() && e.name.startsWith(PASTE_DIR_PREFIX)) {
        try {
          fs.rmSync(path.join(tmpRoot, e.name), { recursive: true });
        } catch (_) {
          /* ignore */
        }
      }
    }
    const pasteDir = path.join(tmpRoot, `${PASTE_DIR_PREFIX}${Date.now()}`);
    fs.mkdirSync(pasteDir, { recursive: true });
    const writtenPaths = [];
    const seen = new Set();
    for (const f of payload.files) {
      if (!f.name || typeof f.data !== 'string') continue;
      let base = sanitizeFileName(f.name);
      if (seen.has(base)) {
        const ext = path.extname(base);
        const stem = path.basename(base, ext) || base;
        let n = 1;
        while (seen.has(base)) {
          base = `${stem} (${n})${ext}`;
          n += 1;
        }
      }
      seen.add(base);
      const filePath = path.join(pasteDir, base);
      const buf = Buffer.from(f.data, 'base64');
      fs.writeFileSync(filePath, buf);
      writtenPaths.push(filePath);
    }
    if (writtenPaths.length === 0) {
      try {
        fs.rmSync(pasteDir, { recursive: true });
      } catch (_) {
        /* ignore */
      }
      return { ok: false, error: 'No valid files' };
    }
    await setClipboardToPaths(writtenPaths);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('clipboard:writeFilesFromServer', async (_event, payload) => {
  if (process.platform !== 'win32' || !payload?.items?.length) {
    return { ok: false, error: 'Not available' };
  }

  const origin = typeof payload.origin === 'string' ? payload.origin : '';
  if (!origin) {
    return { ok: false, error: 'Missing origin' };
  }

  const base = origin.replace(/\/$/, '');
  const tmpRoot = os.tmpdir();

  try {
    const existing = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const e of existing) {
      if (e.isDirectory() && e.name.startsWith(PASTE_DIR_PREFIX)) {
        try {
          fs.rmSync(path.join(tmpRoot, e.name), { recursive: true });
        } catch (_) {
          /* ignore */
        }
      }
    }

    const pasteDir = path.join(tmpRoot, `${PASTE_DIR_PREFIX}${Date.now()}`);
    fs.mkdirSync(pasteDir, { recursive: true });

    const writtenPaths = [];
    const seen = new Set();

    for (const item of payload.items) {
      if (!item || !item.id || !item.name) continue;

      let baseName = sanitizeFileName(String(item.name));
      if (seen.has(baseName)) {
        const ext = path.extname(baseName);
        const stem = path.basename(baseName, ext) || baseName;
        let n = 1;
        while (seen.has(baseName)) {
          baseName = `${stem} (${n})${ext}`;
          n += 1;
        }
      }
      seen.add(baseName);

      const filePath = path.join(pasteDir, baseName);
      const downloadUrl = `${base}/api/files/${encodeURIComponent(String(item.id))}/download`;

      try {
        // Stream from server directly into file without loading into renderer memory
        await downloadToFile(downloadUrl, filePath);
        writtenPaths.push(filePath);
      } catch (_) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (writtenPaths.length === 0) {
      try {
        fs.rmSync(pasteDir, { recursive: true });
      } catch (_) {
        /* ignore */
      }
      return { ok: false, error: 'Failed to download files' };
    }

    await setClipboardToPaths(writtenPaths);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function cleanTempClipboardDirs(maxAgeMs) {
  cleanTempDirsByPrefix(PASTE_DIR_PREFIX, maxAgeMs);
}

function cleanTempEditDirs(maxAgeMs) {
  cleanTempDirsByPrefix(EDIT_DIR_PREFIX, maxAgeMs);
}

ipcMain.handle('files:editWithDesktop', async (_event, payload) => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Desktop editing is only supported on Windows' };
  }

  try {
    const origin = typeof payload?.origin === 'string' ? payload.origin : '';
    const item = payload?.item;
    if (!origin || !item || !item.id || !item.name) {
      return { ok: false, error: 'Invalid payload' };
    }

    const base = origin.replace(/\/$/, '');
    const downloadUrl = `${base}/api/files/${encodeURIComponent(String(item.id))}/download`;

    const editDir = createTempDir(EDIT_DIR_PREFIX);
    const filePath = path.join(editDir, sanitizeFileName(String(item.name)));

    let lastHash = null;
    let lastUploadTime = 0;
    const THROTTLE_MS = 5000;
    let watcher = null;
    let uploadInProgress = false;

    try {
      await downloadToFile(downloadUrl, filePath);
      try {
        lastHash = await hashFile(filePath);
      } catch {
        lastHash = null;
      }
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : 'Failed to download file',
      };
    }

    async function uploadIfChangedThrottled() {
      const now = Date.now();
      if (now - lastUploadTime < THROTTLE_MS) return;

      if (uploadInProgress) return;
      uploadInProgress = true;

      let newHash;
      try {
        newHash = await hashFile(filePath);
      } catch {
        uploadInProgress = false;
        return;
      }

      if (lastHash && newHash && lastHash === newHash) {
        uploadInProgress = false;
        return;
      }

      try {
        await uploadFileToReplace(base, String(item.id), filePath, String(item.name));
        lastHash = newHash;
        lastUploadTime = Date.now();
      } catch {
        // Silently ignore upload errors here; backend/logs can capture them
      } finally {
        uploadInProgress = false;
      }
    }

    try {
      watcher = fs.watch(filePath, () => {
        void uploadIfChangedThrottled();
      });
      watcher.on('error', () => {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      });
    } catch {
      watcher = null;
    }

    try {
      const errorMessage = await shell.openPath(filePath);
      if (errorMessage) {
        return {
          ok: false,
          error: errorMessage,
        };
      }
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : 'Failed to open file with default application',
      };
    }

    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : 'Unexpected error',
    };
  }
});

app.whenReady().then(() => {
  const serverUrl = getServerUrl();
  createWindow(serverUrl || NO_SERVER_URL_PAGE);

  // Run cleanup roughly once per hour, deleting temp dirs that are at least 24 hours old.
  const CLEAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  setInterval(() => {
    if (process.platform === 'win32') {
      cleanTempClipboardDirs(MAX_AGE_MS);
      cleanTempEditDirs(MAX_AGE_MS);
    }
  }, CLEAN_INTERVAL_MS);
});

app.on('before-quit', () => {
  if (process.platform === 'win32') {
    cleanTempClipboardDirs(0);
    cleanTempEditDirs(0);
  }
});

app.on('window-all-closed', () => app.quit());
