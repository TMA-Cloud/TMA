const { logger } = require('../config/logger');
const { getShareBaseUrlOrigin } = require('../services/shareBaseUrl.service');

/**
 * Get share base URL origin from service
 * Service uses Redis cache (shared across instances) for performance
 * No local caching to avoid multi-instance desynchronization
 */
async function getConfiguredShareOrigin() {
  try {
    return await getShareBaseUrlOrigin();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load share base URL origin');
    return null;
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

async function getShareBaseUrl(req) {
  // Get configured origin (async, but uses cache for performance)
  const configuredOrigin = await getConfiguredShareOrigin();
  let base = configuredOrigin || getRequestOrigin(req);

  // If we still don't have a usable origin (very rare edge case - no host header and no proxy headers),
  // fall back to localhost. This should only happen in unusual configurations.
  if (!base) {
    base = 'http://localhost';
    logger.warn(
      {},
      'Unable to determine share link base URL from request or database setting; falling back to http://localhost.'
    );
  }

  // Ensure no trailing slash to avoid double slashes when building URLs.
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

async function buildShareLink(token, req) {
  const baseUrl = await getShareBaseUrl(req);
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

// Get the host from share base URL if configured (async for middleware)
// For multi-instance support, this checks Redis cache directly via service
async function getShareBaseHost() {
  const { getShareBaseHost: getHostFromService } = require('../services/shareBaseUrl.service');
  return getHostFromService();
}

module.exports = {
  getShareBaseUrl,
  buildShareLink,
  getRequestHost,
  getShareBaseHost,
};
