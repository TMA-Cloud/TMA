const { logger } = require('../config/logger');

// Resolve and normalize the configured share base URL (if provided).
// We cache the parsed origin at module load time to avoid repeated parsing.
let configuredShareOrigin = null;
const rawShareBaseUrl = process.env.SHARE_BASE_URL ? process.env.SHARE_BASE_URL.trim() : '';

if (rawShareBaseUrl) {
  try {
    configuredShareOrigin = new URL(rawShareBaseUrl).origin;
  } catch (error) {
    // Keep running with fallback while warning about the bad config.
    logger.warn(
      { err: error, shareBaseUrl: rawShareBaseUrl },
      'Invalid SHARE_BASE_URL, falling back to request origin'
    );
  }
}

function getRequestOrigin(req) {
  // Respect reverse proxy headers if present.
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];

  let protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  // Guard against malformed or empty protocol (e.g., leading comma)
  if (!protocol) {
    logger.warn(
      { forwardedProto, fallbackProtocol: req.protocol },
      'Invalid X-Forwarded-Proto header when determining share link origin; falling back to request protocol'
    );
    protocol = req.protocol || 'https';
  }
  // x-forwarded-host can be a comma-separated list from proxy chains; use the first entry
  const rawHost = forwardedHost || req.get('host');
  const host = rawHost ? rawHost.split(',')[0].trim() : rawHost;

  // If we still don't have a host, avoid generating invalid origins like "https://undefined"
  if (!host) {
    logger.warn(
      {
        forwardedHost,
        requestHost: req.get('host'),
      },
      'Could not determine request host for share link origin; falling back to relative URLs'
    );
    return '';
  }

  return `${protocol}://${host}`;
}

function getShareBaseUrl(req) {
  let base = configuredShareOrigin || getRequestOrigin(req);

  // If we still don't have a usable origin (very rare edge case - no host header and no proxy headers),
  // fall back to localhost. This should only happen in unusual configurations.
  if (!base) {
    base = 'http://localhost';
    logger.warn(
      {},
      'Unable to determine share link base URL from request or SHARE_BASE_URL; falling back to http://localhost.'
    );
  }

  // Ensure no trailing slash to avoid double slashes when building URLs.
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function buildShareLink(token, req) {
  const baseUrl = getShareBaseUrl(req);
  // Ensure token is URL-safe in path segment
  const encodedToken = encodeURIComponent(token);
  return `${baseUrl}/s/${encodedToken}`;
}

// Helper to get the request host (for middleware that needs to check host)
function getRequestHost(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  const rawHost = forwardedHost || req.get('host');
  return rawHost ? rawHost.split(',')[0].trim() : rawHost;
}

// Get the host from SHARE_BASE_URL if configured
function getShareBaseHost() {
  if (!configuredShareOrigin) return null;
  try {
    return new URL(configuredShareOrigin).host;
  } catch {
    return null;
  }
}

module.exports = {
  getShareBaseUrl,
  buildShareLink,
  getRequestHost,
  getShareBaseHost,
};
