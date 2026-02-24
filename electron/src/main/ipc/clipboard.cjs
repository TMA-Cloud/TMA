const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain } = require('electron');
const { runPowerShell, escapePathForPowerShellLiteralPath } = require('../utils/powershell.cjs');
const { PASTE_DIR_PREFIX, sanitizeFileName, setClipboardToPaths, downloadToFile } = require('../utils/file-utils.cjs');

const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function registerClipboardHandlers() {
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
          const mime = EXT_TO_MIME[ext] || 'application/octet-stream';
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
}

module.exports = { registerClipboardHandlers };
