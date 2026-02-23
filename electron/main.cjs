const { app, BrowserWindow, ipcMain, Menu, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EMBEDDED_SERVER_URL = '';

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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'TMA Cloud',
    show: false,
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
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }"',
      { encoding: 'utf8', timeout: 5000 }
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
  const tmp = path.join(os.tmpdir(), `electron-clipboard-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmp, paths.join('\n'), 'utf8');
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $col = New-Object System.Collections.Specialized.StringCollection; Get-Content -LiteralPath '${tmp.replace(/'/g, "''")}' | ForEach-Object { $col.Add($_) }; [System.Windows.Forms.Clipboard]::SetFileDropList($col)`;
    await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 5000 });
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

function sanitizeFileName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'file';
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
  const tmpRoot = os.tmpdir();
  const tmp = path.join(tmpRoot, `electron-clipboard-${Date.now()}.txt`);
  fs.writeFileSync(tmp, writtenPaths.join('\n'), 'utf8');
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $col = New-Object System.Collections.Specialized.StringCollection; Get-Content -LiteralPath '${tmp.replace(/'/g, "''")}' | ForEach-Object { $col.Add($_) }; [System.Windows.Forms.Clipboard]::SetFileDropList($col)`;
  return execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 5000 }).then(() => {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
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
  const tmpRoot = os.tmpdir();
  const now = Date.now();
  try {
    const existing = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const e of existing) {
      if (!e.isDirectory() || !e.name.startsWith(PASTE_DIR_PREFIX)) continue;
      const dirPath = path.join(tmpRoot, e.name);
      try {
        const stat = fs.statSync(dirPath);
        const age = now - stat.mtimeMs;
        if (age >= maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true });
        }
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore */
  }
}

app.whenReady().then(() => {
  const serverUrl = getServerUrl();
  createWindow(serverUrl || NO_SERVER_URL_PAGE);

  const CLEAN_INTERVAL_MS = 5 * 60 * 1000;
  const MAX_AGE_MS = 10 * 60 * 1000;
  setInterval(() => {
    if (process.platform === 'win32') cleanTempClipboardDirs(MAX_AGE_MS);
  }, CLEAN_INTERVAL_MS);
});

app.on('before-quit', () => {
  if (process.platform === 'win32') cleanTempClipboardDirs(0);
});

app.on('window-all-closed', () => app.quit());
