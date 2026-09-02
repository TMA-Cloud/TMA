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

module.exports = { getCookieHeader, handleResponseError, pipeResponseToFile, getJson, apiPostJson };
