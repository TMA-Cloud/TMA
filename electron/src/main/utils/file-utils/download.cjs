/*
 * Download helpers: stream a file (or a bulk POST result) to disk, fetch a
 * file's backend metadata, and list a directory. All authenticated via the
 * default session cookies through the shared http helpers.
 */
const { net } = require('electron');
const { getCookieHeader, handleResponseError, pipeResponseToFile, getJson } = require('./http.cjs');

async function downloadToFile(url, filePath, onProgress) {
  const cookieHeader = await getCookieHeader(url);

  return new Promise((resolve, reject) => {
    const request = net.request({ url });
    if (cookieHeader) {
      request.setHeader('Cookie', cookieHeader);
    }
    request.on('response', response => {
      if (handleResponseError(response, reject, 'Download failed')) return;
      pipeResponseToFile(response, filePath, resolve, reject, onProgress);
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * POST JSON body to a URL and stream the response to a file (e.g. bulk download zip).
 * Uses the same session cookies as downloadToFile.
 */
async function downloadPostToFile(url, jsonBody, filePath, onProgress) {
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
      pipeResponseToFile(response, filePath, resolve, reject, onProgress);
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

/**
 * List the files/folders in a directory (root when parentId is falsy).
 * Returns the raw array of entries from GET /api/files.
 */
async function listFilesFromBackend(base, parentId) {
  const url = parentId ? `${base}/api/files?parentId=${encodeURIComponent(parentId)}` : `${base}/api/files`;
  const cookieHeader = await getCookieHeader(base);
  return getJson(url, cookieHeader);
}

module.exports = { downloadToFile, downloadPostToFile, getFileInfoFromBackend, listFilesFromBackend };
