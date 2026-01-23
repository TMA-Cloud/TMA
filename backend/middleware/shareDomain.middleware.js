const { logger } = require('../config/logger');
const { getRequestHost, getShareBaseHost } = require('../utils/shareLink');

/**
 * Middleware to block access to the main app on the share domain.
 * If share base URL is configured in database and the request host matches it,
 * only allow /s/* routes. Block all other routes (including /, /api/*, etc.)
 *
 * Uses Redis cache directly for multi-instance support (no in-memory cache dependency)
 */
async function blockMainAppOnShareDomain(req, res, next) {
  const shareBaseHost = await getShareBaseHost();

  // If share base URL is not configured, allow all requests
  if (!shareBaseHost) {
    return next();
  }

  const requestHost = getRequestHost(req);

  // If request host doesn't match share domain, allow it (normal app access)
  if (!requestHost || requestHost.toLowerCase() !== shareBaseHost.toLowerCase()) {
    return next();
  }

  // Request is coming to share domain - allow:
  // - /s/* routes (share links)
  // - /health (health check for monitoring)
  // - /metrics (metrics endpoint)
  if (req.path.startsWith('/s/') || req.path === '/health' || req.path === '/metrics') {
    return next();
  }

  // Block all other routes on share domain (including /, /api/*, static files, etc.)
  // Return 404 immediately to stop request processing - no further middleware or routes will execute
  logger.warn(
    {
      path: req.path,
      method: req.method,
      shareDomain: shareBaseHost,
      requestHost,
    },
    'Blocked access to main app route on share domain'
  );

  // Stop request immediately - don't call next(), don't process body, don't hit routes
  return res.status(404).send('Not Found');
}

module.exports = { blockMainAppOnShareDomain };
