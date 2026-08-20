/**
 * Normalize an OnlyOffice Document Server base URL into an absolute URL with an
 * explicit http/https scheme and no trailing slash.
 *
 * OnlyOffice requires the api.js script, the command service, and document URLs
 * to be loaded from absolute URLs. A bare host like "192.168.1.1" breaks in two
 * ways: in the browser it resolves relative to the app origin (fetching the
 * SPA's index.html instead of api.js), and on the server `new URL()` throws
 * "Invalid URL" (breaking autosave/forcesave and the CSP origin lookup).
 *
 * A scheme-less value is treated as http:// — the common shape an admin types
 * for a self-hosted document server on a LAN ("192.168.1.1" or "ds:8080").
 *
 * @param {string} rawUrl - value as entered/stored
 * @returns {string} absolute URL, no trailing slash (subpaths preserved)
 * @throws {Error} if the value cannot be parsed into an http/https URL
 */
function normalizeOnlyOfficeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new Error('OnlyOffice URL must be a string');
  }

  let value = rawUrl.trim();
  if (!value) {
    throw new Error('OnlyOffice URL must not be empty');
  }

  // Prepend a scheme when the admin typed a bare host/IP (optionally with a
  // port or path). The test requires a real "scheme://" prefix — a bare
  // "host:port" has no "//" and is correctly treated as scheme-less.
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)) {
    value = `http://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid OnlyOffice URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OnlyOffice URL must use http or https');
  }

  // Drop any hash and trailing slash so callers can append "/web-apps/..."
  // cleanly, while preserving an optional reverse-proxy subpath and query.
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * Best-effort normalization for values already stored in the database. Returns
 * the normalized absolute URL, or the original value if it cannot be parsed, so
 * a legacy/garbage value never makes a read path throw. New writes are validated
 * strictly via normalizeOnlyOfficeUrl instead.
 *
 * @param {string|null|undefined} rawUrl
 * @returns {string|null}
 */
function normalizeOnlyOfficeUrlSafe(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return rawUrl ?? null;
  }
  try {
    return normalizeOnlyOfficeUrl(rawUrl);
  } catch {
    return rawUrl;
  }
}

export { normalizeOnlyOfficeUrl, normalizeOnlyOfficeUrlSafe };
