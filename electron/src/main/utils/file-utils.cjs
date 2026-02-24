const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { net, session } = require('electron');
const { escapePathForPowerShellLiteralPath, runPowerShell } = require('./powershell.cjs');

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

/**
 * POST JSON body to a URL and stream the response to a file (e.g. bulk download zip).
 * Uses the same session cookies as downloadToFile.
 */
async function downloadPostToFile(url, jsonBody, filePath) {
  let cookieHeader = '';
  try {
    const cookies = await session.defaultSession.cookies.get({ url });
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    cookieHeader = '';
  }

  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieHeader && { Cookie: cookieHeader }),
      },
    });
    request.write(JSON.stringify(jsonBody));
    request.end();

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

function cleanTempClipboardDirs(maxAgeMs) {
  cleanTempDirsByPrefix(PASTE_DIR_PREFIX, maxAgeMs);
}

function cleanTempEditDirs(maxAgeMs) {
  cleanTempDirsByPrefix(EDIT_DIR_PREFIX, maxAgeMs);
}

module.exports = {
  PASTE_DIR_PREFIX,
  EDIT_DIR_PREFIX,
  sanitizeFileName,
  createTempDir,
  downloadToFile,
  downloadPostToFile,
  setClipboardToPaths,
  cleanTempDirsByPrefix,
  cleanTempClipboardDirs,
  cleanTempEditDirs,
  uploadFileToReplace,
  hashFile,
};
