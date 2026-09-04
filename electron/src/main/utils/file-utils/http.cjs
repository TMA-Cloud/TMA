/*
 * Low-level HTTP helpers over Electron's `net`, all authenticated with the
 * default session's cookies. Shared by the upload, download, and cloud-drive
 * bridge layers.
 */
const fs = require('fs');
const { net, session } = require('electron');

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
 * Build a throttled byte-progress emitter that sends `{ id, loaded, total }` to
 * the renderer on `channel`. Returns undefined without an id (so callers pay
 * nothing when no one is listening). Emits at most every 100ms, plus the final byte.
 */
function makeIpcProgressEmitter(win, channel, id) {
  if (!id || !win) return undefined;
  let last = 0;
  return (loaded, total) => {
    const now = Date.now();
    const done = total > 0 && loaded >= total;
    if (!done && now - last < 100) return;
    last = now;
    if (!win.isDestroyed()) win.webContents.send(channel, { id, loaded, total });
  };
}

/** Content-Length off an Electron `net` response (headers are lowercased, values may be arrays). */
function contentLengthOf(response) {
  const raw = response?.headers?.['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const total = Number(value);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * Pipe a 2xx response body to the given file path with backpressure handling.
 * Resolves when the file is fully written, rejects on stream errors.
 * `onProgress(loaded, total)` (optional) is called as bytes arrive; `total` is 0
 * when the response carries no Content-Length.
 */
function pipeResponseToFile(response, filePath, resolve, reject, onProgress) {
  const fileStream = fs.createWriteStream(filePath);
  const total = contentLengthOf(response);
  let loaded = 0;

  response.on('data', chunk => {
    loaded += chunk.length;
    if (typeof onProgress === 'function') onProgress(loaded, total);
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

module.exports = {
  getCookieHeader,
  handleResponseError,
  pipeResponseToFile,
  makeIpcProgressEmitter,
  getJson,
  apiPostJson,
};
