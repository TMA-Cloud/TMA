const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { net, session } = require('electron');
const { escapePathForPowerShellLiteralPath, runPowerShell } = require('./powershell.cjs');

const { getServerUrl } = require('../config.cjs');

const PASTE_DIR_PREFIX = 'tma-cloud-paste-';
const EDIT_DIR_PREFIX = 'tma-cloud-edit-';

/**
 * Validate that an origin from an IPC payload matches the trusted server URL.
 * Returns the normalised origin (no trailing slash) or null if invalid.
 */
function validateOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return null;
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;
  try {
    const expected = new URL(serverUrl).origin;
    const received = new URL(origin).origin;
    return expected === received ? received : null;
  } catch {
    return null;
  }
}

function sanitizeFileName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'file';
}

// Minimal extension -> MIME map for the multipart upload Content-Type.
const MIME_BY_EXT = {
  // images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  weba: 'audio/webm',
  // documents
  pdf: 'application/pdf',
  txt: 'text/plain',
  rtf: 'application/rtf',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  // text / web / data
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  // archives
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

/** Best-effort MIME type for a filename; null when unknown. */
function mimeForFilename(name) {
  const ext = path
    .extname(String(name || ''))
    .slice(1)
    .toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || null;
}

/**
 * Append a "(n)" suffix to a filename until it's not present in the given set.
 */
function deduplicateFileName(base, seenSet) {
  if (!seenSet.has(base)) return base;
  const ext = path.extname(base);
  const stem = path.basename(base, ext) || base;
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (seenSet.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

/**
 * Build a `Cookie:` header string from the default session cookies for the
 * given URL. Returns '' on any error so callers can always send the request.
 */
async function getCookieHeader(url) {
  try {
    const cookies = await session.defaultSession.cookies.get({ url });
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/**
 * If `response` has a non-2xx status, collect up to 4KB of body and reject
 * the given promise with a formatted error. Returns true if handled.
 */
function handleResponseError(response, reject, label) {
  if (response.statusCode >= 200 && response.statusCode < 300) return false;
  const status = response.statusCode || 0;
  let body = '';
  response.on('data', chunk => {
    if (body.length < 4096) {
      body += chunk.toString('utf8');
    }
  });
  response.on('end', () => {
    reject(new Error(body ? `${label} (${status}): ${body}` : `${label} (${status})`));
  });
  response.on('error', reject);
  return true;
}

/**
 * Pipe a 2xx response body to the given file path with backpressure handling.
 * Resolves when the file is fully written, rejects on stream errors.
 */
function pipeResponseToFile(response, filePath, resolve, reject) {
  const fileStream = fs.createWriteStream(filePath);

  response.on('data', chunk => {
    if (!fileStream.write(chunk)) {
      response.pause();
    }
  });
  fileStream.on('drain', () => {
    response.resume();
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
}

/**
 * Stream a file as multipart/form-data to `url` with the given cookie header.
 * Shared body for uploadFileToReplace (replace existing file) and
 * uploadDerivedFile (upload a derived/exported file) — they only differ by URL.
 */
function postMultipartFile(url, filePath, fileName, cookieHeader) {
  const boundary = `----ElectronFormBoundary${crypto.randomBytes(16).toString('hex')}`;
  const safeFileName = String(fileName).replace(/"/g, '\\"');
  const contentType = mimeForFilename(fileName) || 'application/octet-stream';
  const preamble =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const closing = `\r\n--${boundary}--\r\n`;

  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
    if (cookieHeader) {
      request.setHeader('Cookie', cookieHeader);
    }

    request.on('response', response => {
      if (handleResponseError(response, reject, 'Upload failed')) return;
      response.on('data', () => {});
      response.on('end', () => resolve());
      response.on('error', reject);
    });
    request.on('error', reject);

    request.write(preamble);

    const fileStream = fs.createReadStream(filePath);
    fileStream.on('data', chunk => {
      if (!request.write(chunk)) {
        fileStream.pause();
      }
    });
    request.on('drain', () => {
      fileStream.resume();
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

function createTempDir(prefix) {
  const tmpRoot = os.tmpdir();
  const dir = path.join(tmpRoot, `${prefix}${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadToFile(url, filePath) {
  const cookieHeader = await getCookieHeader(url);

  return new Promise((resolve, reject) => {
    const request = net.request({ url });
    if (cookieHeader) {
      request.setHeader('Cookie', cookieHeader);
    }
    request.on('response', response => {
      if (handleResponseError(response, reject, 'Download failed')) return;
      pipeResponseToFile(response, filePath, resolve, reject);
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
  const cookieHeader = await getCookieHeader(url);

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
      if (handleResponseError(response, reject, 'Download failed')) return;
      pipeResponseToFile(response, filePath, resolve, reject);
    });
    request.on('error', reject);
  });
}

async function getFileInfoFromBackend(base, fileId) {
  const url = `${base}/api/files/${encodeURIComponent(String(fileId))}/info`;

  const cookieHeader = await getCookieHeader(base);

  return new Promise((resolve, reject) => {
    const request = net.request({ url });
    if (cookieHeader) {
      request.setHeader('Cookie', cookieHeader);
    }

    let body = '';

    request.on('response', response => {
      response.on('data', chunk => {
        body += chunk.toString('utf8');
      });

      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const status = response.statusCode || 0;
          return reject(new Error(body ? `File info failed (${status}): ${body}` : `File info failed (${status})`));
        }
        try {
          const data = body ? JSON.parse(body) : {};
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });

      response.on('error', reject);
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

function cleanTempDirsByPrefix(prefix, maxAgeMs, excludeDirs) {
  const tmpRoot = os.tmpdir();
  const now = Date.now();
  const exclude = excludeDirs instanceof Set ? excludeDirs : null;
  try {
    const existing = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const e of existing) {
      if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
      const dirPath = path.join(tmpRoot, e.name);
      // Skip directories that are still in use by an active session.
      if (exclude && exclude.has(dirPath)) continue;
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
  const cookieHeader = await getCookieHeader(base);
  return postMultipartFile(url, filePath, fileName, cookieHeader);
}

/**
 * Upload a new file derived from an existing one (e.g. "Save as PDF" from Word)
 * into the same parent folder as the original.
 *
 * Backend route: POST /api/files/:id/derived
 * Body: multipart/form-data with single "file" field (same as regular upload).
 */
async function uploadDerivedFile(base, fileId, filePath, fileName) {
  const url = `${base}/api/files/${encodeURIComponent(fileId)}/derived`;
  const cookieHeader = await getCookieHeader(base);
  return postMultipartFile(url, filePath, fileName, cookieHeader);
}

/**
 * GET a URL and parse the JSON body, using the default session cookies.
 * Shared by the cloud-drive bridge for directory listings.
 */
function getJson(url, cookieHeader) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url });
    if (cookieHeader) request.setHeader('Cookie', cookieHeader);
    let body = '';
    request.on('response', response => {
      const status = response.statusCode || 0;
      response.on('data', chunk => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        if (status < 200 || status >= 300) {
          return reject(new Error(body ? `GET failed (${status}): ${body}` : `GET failed (${status})`));
        }
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (err) {
          reject(err);
        }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * POST a JSON body and parse the JSON response, using session cookies.
 * Used for folder/rename/move/delete operations from the cloud-drive bridge.
 */
function apiPostJson(base, pathname, body) {
  const url = `${base}${pathname}`;
  return getCookieHeader(base).then(
    cookieHeader =>
      new Promise((resolve, reject) => {
        const request = net.request({
          method: 'POST',
          url,
          headers: {
            'Content-Type': 'application/json',
            ...(cookieHeader && { Cookie: cookieHeader }),
          },
        });
        let resp = '';
        request.on('response', response => {
          const status = response.statusCode || 0;
          response.on('data', chunk => {
            resp += chunk.toString('utf8');
          });
          response.on('end', () => {
            if (status < 200 || status >= 300) {
              return reject(
                new Error(resp ? `${pathname} failed (${status}): ${resp}` : `${pathname} failed (${status})`)
              );
            }
            try {
              resolve(resp ? JSON.parse(resp) : {});
            } catch {
              resolve({});
            }
          });
          response.on('error', reject);
        });
        request.on('error', reject);
        request.write(JSON.stringify(body));
        request.end();
      })
  );
}

/**
 * List the files/folders in a directory (root when parentId is falsy).
 * Returns the raw array of entries from GET /api/files.
 */
async function listFilesFromBackend(base, parentId) {
  const url = parentId ? `${base}/api/files?parentId=${encodeURIComponent(parentId)}` : `${base}/api/files`;
  const cookieHeader = await getCookieHeader(base);
  return getJson(url, cookieHeader);
}

/**
 * Stream a local file as a brand-new upload into a folder. The `parentId`
 * text field is emitted BEFORE the file part so the backend's busboy stream
 * parser has it available (fields must precede the file). Returns the created
 * file object (including its new id).
 */
function uploadNewFile(base, parentId, filePath, fileName) {
  const url = `${base}/api/files/upload`;
  return getCookieHeader(base).then(cookieHeader => {
    const boundary = `----ElectronFormBoundary${crypto.randomBytes(16).toString('hex')}`;
    const safeFileName = String(fileName).replace(/"/g, '\\"');
    const contentType = mimeForFilename(fileName) || 'application/octet-stream';
    let preamble = '';
    if (parentId) {
      preamble += `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${parentId}\r\n`;
    }
    preamble +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--\r\n`;

    return new Promise((resolve, reject) => {
      const request = net.request({ method: 'POST', url });
      request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
      if (cookieHeader) request.setHeader('Cookie', cookieHeader);

      let body = '';
      request.on('response', response => {
        const status = response.statusCode || 0;
        response.on('data', chunk => {
          if (body.length < 8192) body += chunk.toString('utf8');
        });
        response.on('end', () => {
          if (status < 200 || status >= 300) {
            return reject(new Error(body ? `Upload failed (${status}): ${body}` : `Upload failed (${status})`));
          }
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve({});
          }
        });
        response.on('error', reject);
      });
      request.on('error', reject);

      request.write(preamble);
      const fileStream = fs.createReadStream(filePath);
      fileStream.on('data', chunk => {
        if (!request.write(chunk)) fileStream.pause();
      });
      request.on('drain', () => fileStream.resume());
      fileStream.on('end', () => {
        request.write(closing);
        request.end();
      });
      fileStream.on('error', err => {
        request.destroy();
        reject(err);
      });
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

function cleanTempClipboardDirs(maxAgeMs, excludeDirs) {
  cleanTempDirsByPrefix(PASTE_DIR_PREFIX, maxAgeMs, excludeDirs);
}

function cleanTempEditDirs(maxAgeMs, excludeDirs) {
  cleanTempDirsByPrefix(EDIT_DIR_PREFIX, maxAgeMs, excludeDirs);
}

module.exports = {
  PASTE_DIR_PREFIX,
  EDIT_DIR_PREFIX,
  sanitizeFileName,
  deduplicateFileName,
  createTempDir,
  downloadToFile,
  downloadPostToFile,
  getFileInfoFromBackend,
  setClipboardToPaths,
  cleanTempDirsByPrefix,
  cleanTempClipboardDirs,
  cleanTempEditDirs,
  uploadFileToReplace,
  uploadDerivedFile,
  hashFile,
  validateOrigin,
  getJson,
  apiPostJson,
  listFilesFromBackend,
  uploadNewFile,
  getCookieHeader,
};
