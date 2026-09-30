/*
 * Download helpers: stream a file (or a bulk POST result) to disk, fetch a
 * file's backend metadata, and list a directory. All authenticated via the
 * default session cookies through the shared http helpers.
 */
const { net } = require('electron');
const { getCookieHeader, handleResponseError, pipeResponseToFile, getJsonWithHeaders } = require('./http.cjs');

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

const LIST_PAGE_SIZE = 500;
const MAX_LIST_PAGES = 1000;

/**
 * List every file/folder in a directory (root when parentId is falsy).
 * GET /api/files is keyset-paged (next cursor in X-Next-Cursor); reading only
 * the first page hid everything past 200 entries from the mounted drive.
 */
async function listFilesFromBackend(base, parentId) {
  const cookieHeader = await getCookieHeader(base);
  const entries = [];
  let cursor = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
    if (parentId) params.set('parentId', parentId);
    if (cursor) params.set('cursor', cursor);
    const { data, headers } = await getJsonWithHeaders(`${base}/api/files?${params}`, cookieHeader);
    if (!Array.isArray(data)) return page === 0 ? data : entries;
    entries.push(...data);
    const raw = headers['x-next-cursor'];
    const next = Array.isArray(raw) ? raw[0] : raw;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return entries;
}

module.exports = { downloadToFile, downloadPostToFile, getFileInfoFromBackend, listFilesFromBackend };
