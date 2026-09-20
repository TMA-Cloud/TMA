/*
 * Upload helpers: stream a local file to the backend as multipart/form-data,
 * either replacing an existing file, uploading a derived export, or creating a
 * brand-new file. All authenticated via the default session cookies.
 */
const fs = require('fs');
const crypto = require('crypto');
const { net } = require('electron');
const { mimeForFilename } = require('../mime-types.cjs');
const { getCookieHeader, handleResponseError, getJson, apiPostJson } = require('./http.cjs');

/** Bytes worded exactly as the web app words them (utils/storageUtils.formatBytes). */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${parseFloat(value.toFixed(2))} ${units[unit]}`;
}

/**
 * The preflight the renderer runs, over the same two endpoints, so an upload
 * from here is refused for the same reasons. Throws with the message to show.
 */
async function precheckUploads(base, files) {
  const cookieHeader = await getCookieHeader(base);
  const { maxBytes } = (await getJson(`${base}/api/user/max-upload-size-config`, cookieHeader)) || {};
  if (Number.isFinite(maxBytes)) {
    const oversized = files.find(file => file.size > maxBytes);
    if (oversized) {
      throw new Error(`"${oversized.name}" is too large. Maximum upload size is ${formatBytes(maxBytes)}.`);
    }
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  try {
    await apiPostJson(base, '/api/files/upload/check', { fileSize: total });
  } catch (error) {
    throw new Error(error?.body?.message || 'Storage limit exceeded.', { cause: error });
  }
}

/**
 * The local file's modification time, as the epoch-millisecond field the upload
 * endpoints read. Here we have a real filesystem to ask, so the value is the
 * file's own mtime not the browser's second-hand copy of it.
 */
function clientMtimeField(boundary, filePath) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return '';
  }
  if (!Number.isFinite(mtimeMs)) return '';
  return `--${boundary}\r\nContent-Disposition: form-data; name="lastModifiedTimes"\r\n\r\n${Math.trunc(mtimeMs)}\r\n`;
}

/**
 * Put the body on the wire as it is written: Electron otherwise buffers all of
 * it and sends it on end(), so nothing is really streamed and a cancel aborts a
 * request the server never saw. Must be set before the first write.
 */
function streamBody(request) {
  request.chunkedEncoding = true;
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
    clientMtimeField(boundary, filePath) +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const closing = `\r\n--${boundary}--\r\n`;

  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url });
    streamBody(request);
    request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
    request.setHeader('X-TMA-Desktop-Client', '1');
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

/** The rejection a cancelled upload throws; callers tell it apart by `.aborted`. */
function abortError() {
  return Object.assign(new Error('Upload cancelled'), { name: 'AbortError', aborted: true });
}

/** Tear the request down when `signal` fires; the returned cleanup unhooks it. */
function wireAbort(signal, teardown) {
  if (!signal) return () => {};
  const onAbort = () => teardown();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Stream a local file as a brand-new upload into a folder. The `parentId`
 * text field is emitted BEFORE the file part so the backend's busboy stream
 * parser has it available (fields must precede the file). Returns the created
 * file object (including its new id).
 *
 * `options.onProgress(loaded, total)` feeds the renderer's upload card;
 * `options.signal` cancels an upload in flight.
 */
function uploadNewFile(base, parentId, filePath, fileName, options) {
  const { onProgress, signal } = options || {};
  if (signal?.aborted) return Promise.reject(abortError());
  const url = `${base}/api/files/upload`;
  return getCookieHeader(base).then(cookieHeader => {
    const boundary = `----ElectronFormBoundary${crypto.randomBytes(16).toString('hex')}`;
    const safeFileName = String(fileName).replace(/"/g, '\\"');
    const contentType = mimeForFilename(fileName) || 'application/octet-stream';
    let preamble = '';
    if (parentId) {
      preamble += `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${parentId}\r\n`;
    }
    preamble += clientMtimeField(boundary, filePath);
    preamble +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--\r\n`;

    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const request = net.request({ method: 'POST', url });
      streamBody(request);
      request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
      request.setHeader('X-TMA-Desktop-Client', '1');
      if (cookieHeader) request.setHeader('Cookie', cookieHeader);

      let unwire = () => {};
      const fail = err => {
        unwire();
        reject(err);
      };

      let body = '';
      request.on('response', response => {
        const status = response.statusCode || 0;
        response.on('data', chunk => {
          if (body.length < 8192) body += chunk.toString('utf8');
        });
        response.on('end', () => {
          unwire();
          if (status < 200 || status >= 300) {
            return reject(new Error(body ? `Upload failed (${status}): ${body}` : `Upload failed (${status})`));
          }
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve({});
          }
        });
        response.on('error', fail);
      });
      request.on('error', fail);

      request.write(preamble);
      let total = 0;
      if (typeof onProgress === 'function') {
        try {
          total = fs.statSync(filePath).size;
        } catch {
          total = 0;
        }
      }
      let loaded = 0;
      // Writing to an aborted request throws, and a cancel can land between
      // chunks — even from inside onProgress below.
      let aborted = false;
      const fileStream = fs.createReadStream(filePath);
      unwire = wireAbort(signal, () => {
        aborted = true;
        fileStream.destroy();
        request.abort();
        reject(abortError());
      });
      fileStream.on('data', chunk => {
        if (aborted) return;
        if (typeof onProgress === 'function') {
          loaded += chunk.length;
          onProgress(loaded, total);
        }
        if (aborted) return;
        if (!request.write(chunk)) fileStream.pause();
      });
      request.on('drain', () => {
        if (!aborted) fileStream.resume();
      });
      fileStream.on('end', () => {
        if (aborted) return;
        request.write(closing);
        request.end();
      });
      fileStream.on('error', err => {
        if (aborted) return;
        request.destroy();
        fail(err);
      });
    });
  });
}

/**
 * Upload virtual clipboard bytes without staging a plaintext file on disk.
 * The buffer is written in bounded chunks and honors Chromium net backpressure.
 *
 * `options` is uploadNewFile's.
 */
function uploadNewFileData(base, parentId, data, fileName, options) {
  if (!Buffer.isBuffer(data)) throw new TypeError('Upload data must be a Buffer');
  const { onProgress, signal } = options || {};
  if (signal?.aborted) return Promise.reject(abortError());
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

    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const request = net.request({ method: 'POST', url });
      streamBody(request);
      request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
      request.setHeader('X-TMA-Desktop-Client', '1');
      if (cookieHeader) request.setHeader('Cookie', cookieHeader);

      const unwire = wireAbort(signal, () => {
        request.abort();
        reject(abortError());
      });
      const fail = err => {
        unwire();
        reject(err);
      };

      let body = '';
      request.on('response', response => {
        const status = response.statusCode || 0;
        response.on('data', chunk => {
          if (body.length < 8192) body += chunk.toString('utf8');
        });
        response.on('end', () => {
          unwire();
          if (status < 200 || status >= 300) {
            reject(new Error(body ? `Upload failed (${status}): ${body}` : `Upload failed (${status})`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve({});
          }
        });
        response.on('error', fail);
      });
      request.on('error', fail);

      const CHUNK_BYTES = 64 * 1024;
      let offset = 0;
      let writing = false;
      const writeNext = () => {
        if (writing || signal?.aborted) return;
        writing = true;
        while (offset < data.length) {
          const end = Math.min(offset + CHUNK_BYTES, data.length);
          const canContinue = request.write(data.subarray(offset, end));
          offset = end;
          if (typeof onProgress === 'function') onProgress(offset, data.length);
          // onProgress can cancel; anything written after that throws.
          if (signal?.aborted) return;
          if (!canContinue) {
            writing = false;
            return;
          }
        }
        request.end(closing);
      };
      request.on('drain', writeNext);
      request.write(preamble);
      writing = false;
      writeNext();
    });
  });
}

module.exports = {
  precheckUploads,
  clientMtimeField,
  postMultipartFile,
  uploadFileToReplace,
  uploadDerivedFile,
  uploadNewFile,
  uploadNewFileData,
};
