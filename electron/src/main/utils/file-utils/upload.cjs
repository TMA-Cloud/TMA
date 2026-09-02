/*
 * Upload helpers: stream a local file to the backend as multipart/form-data,
 * either replacing an existing file, uploading a derived export, or creating a
 * brand-new file. All authenticated via the default session cookies.
 */
const fs = require('fs');
const crypto = require('crypto');
const { net } = require('electron');
const { mimeForFilename } = require('../mime-types.cjs');
const { getCookieHeader, handleResponseError } = require('./http.cjs');

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
    preamble += clientMtimeField(boundary, filePath);
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

module.exports = {
  clientMtimeField,
  postMultipartFile,
  uploadFileToReplace,
  uploadDerivedFile,
  uploadNewFile,
};
