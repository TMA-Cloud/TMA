/**
 * CSRF defense-in-depth for state-changing requests.
 *
 * Requires a custom `X-Requested-With: XMLHttpRequest` header on every
 * non-safe HTTP method (POST, PUT, PATCH, DELETE).  Browsers will not
 * attach custom headers to cross-origin requests without a CORS preflight
 * that the server would deny, so this effectively blocks CSRF even if
 * SameSite cookies are somehow bypassed.
 *
 * Safe methods (GET, HEAD, OPTIONS) are exempt — they must not mutate state.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // Accept the standard XHR header (frontend) or the Electron desktop client header
  if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers['x-tma-desktop-client']) {
    return next();
  }

  return res.status(403).json({ message: 'Forbidden: missing CSRF header' });
}

export { csrfProtection };
