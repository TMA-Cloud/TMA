const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const EMBEDDED_SERVER_URL = '';

/**
 * Resolve the server URL: embedded build value, or src/config/build-config.json when running from source.
 * Uses app.getAppPath() so it works in both development and packaged app.
 */
function getServerUrl() {
  if (EMBEDDED_SERVER_URL) return EMBEDDED_SERVER_URL;
  const appRoot = app.getAppPath();
  const buildConfigPath = path.join(appRoot, 'src', 'config', 'build-config.json');
  if (fs.existsSync(buildConfigPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(buildConfigPath, 'utf8'));
      if (data.serverUrl) return data.serverUrl;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

const NO_SERVER_URL_PAGE =
  'data:text/html,<h1>Server URL not configured</h1><p>Run from source with <code>src/config/build-config.json</code></p>';

const LOADING_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc}.c{text-align:center}.t{font-size:1.5rem;font-weight:600;letter-spacing:-.02em}.b{height:2px;width:80px;margin:20px auto 0;background:rgba(148,163,184,.2);border-radius:1px;overflow:hidden}.b::after{content:"";display:block;height:100%;width:40%;background:#3b82f6;border-radius:1px;animation:p .6s ease-in-out infinite}@keyframes p{0%,100%{transform:translateX(-100%)}50%{transform:translateX(150%)}}</style></head><body><div class="c"><div class="t">TMA Cloud</div><div class="b"></div></div></body></html>'
  );

function serverErrorPage(serverUrl) {
  const u = serverUrl.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#1a1a2e;color:#e4e4e7;} .box{text-align:center;max-width:420px;padding:2rem;} h1{font-size:1.25rem;font-weight:600;margin:0 0 0.75rem;} p{margin:0;color:#a1a1aa;font-size:0.9375rem;line-height:1.5;} a{color:#60a5fa;}</style></head><body>' +
      '<div class="box"><h1>Could not connect to the server</h1>' +
      '<p>Check that your network is working and the server is running at <strong>' +
      u +
      '</strong></p>' +
      '<p style="margin-top:1rem;">You can try again by closing and reopening the app, or contact your administrator.</p></div></body></html>'
  )}`;
}

module.exports = {
  EMBEDDED_SERVER_URL,
  getServerUrl,
  NO_SERVER_URL_PAGE,
  LOADING_PAGE,
  serverErrorPage,
};
