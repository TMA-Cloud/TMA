const { logger } = require('../config/logger');
const { getElectronOnlyAccessSettings } = require('../models/user.model');

const ELECTRON_HEADER_NAME = 'X-TMA-Desktop-Client';
const ELECTRON_HEADER_EXPECTED_VALUE = 'tma-electron-client-v1';

/**
 * Middleware that, when enabled in app_settings, requires requests to include
 * a custom header that the Electron app injects into all HTTP requests.
 *
 * When require_electron_client is true:
 * - Allows /s/* (share links), /health, and /metrics without the header
 * - Requires the header for all other routes (API and frontend)
 */
async function requireElectronClientIfEnabled(req, res, next) {
  try {
    const enabled = await getElectronOnlyAccessSettings();
    if (!enabled) {
      return next();
    }

    // Always allow share links and operational endpoints
    if (req.path.startsWith('/s/') || req.path === '/health' || req.path === '/metrics') {
      return next();
    }

    const headerValue = req.get(ELECTRON_HEADER_NAME);
    if (headerValue === ELECTRON_HEADER_EXPECTED_VALUE) {
      return next();
    }

    logger.warn(
      {
        path: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
      },
      'Blocked non-desktop client request due to desktop-only access setting'
    );

    // For non-API routes where the client prefers HTML (browser hitting /, etc.),
    // return a friendly branded HTML page instead of raw JSON.
    const wantsHtml = typeof req.accepts === 'function' && req.accepts('html') && !req.path.startsWith('/api');

    if (wantsHtml) {
      const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Desktop app only</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: radial-gradient(circle at top, #1d4ed8 0, #020617 55%, #020617 100%);
        color: #e5e7eb;
      }
      .card {
        background: rgba(15, 23, 42, 0.9);
        border-radius: 18px;
        padding: 32px 28px;
        max-width: 420px;
        width: 100%;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(148, 163, 184, 0.45);
        backdrop-filter: blur(16px);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(22, 163, 74, 0.08);
        color: #bbf7d0;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-weight: 600;
        margin-bottom: 14px;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #22c55e;
        box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.32);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 22px;
        letter-spacing: -0.02em;
      }
      p {
        margin: 0 0 6px;
        font-size: 14px;
        line-height: 1.55;
        color: #9ca3af;
      }
      p.small {
        font-size: 12px;
        color: #6b7280;
        margin-top: 12px;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
          'Courier New', monospace;
        font-size: 12px;
        padding: 2px 5px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.9);
        color: #e5e7eb;
        border: 1px solid rgba(55, 65, 81, 0.9);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="badge">
        <span class="dot"></span>
        <span>Desktop app only</span>
      </div>
      <h1>Access restricted to the desktop app</h1>
      <p>
        This TMA Cloud instance is configured to be accessed only from the desktop application..!!!
      </p>
    </main>
  </body>
</html>`;
      return res.status(403).type('html').send(html);
    }

    return res.status(403).json({
      message: 'This instance is configured for desktop app access only.',
      error: 'DESKTOP_ONLY_ACCESS',
    });
  } catch (err) {
    logger.error({ err }, 'Error in desktop-only access middleware, allowing request to proceed');
    // Fail open on middleware errors to avoid locking out administrators
    return next();
  }
}

module.exports = {
  requireElectronClientIfEnabled,
  ELECTRON_HEADER_NAME,
  ELECTRON_HEADER_EXPECTED_VALUE,
};
