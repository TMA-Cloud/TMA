const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const EMBEDDED_SERVER_URL = '';
const EMBEDDED_UPDATOR_URL = '';

function readBuildConfig() {
  const buildConfigPath = path.join(app.getAppPath(), 'src', 'config', 'build-config.json');
  if (!fs.existsSync(buildConfigPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(buildConfigPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Server URL: embedded value or build-config.json (dev/source). */
function getServerUrl() {
  if (EMBEDDED_SERVER_URL) return EMBEDDED_SERVER_URL;
  const data = readBuildConfig();
  return data?.serverUrl || null;
}

/** Updator URL for installer download: embedded value or build-config.json. */
function getUpdatorUrl() {
  if (EMBEDDED_UPDATOR_URL) return EMBEDDED_UPDATOR_URL;
  const data = readBuildConfig();
  const url = data?.updatorUrl;
  return typeof url === 'string' ? url.trim() : null;
}

/* Chrome pages (splash, connection error, misconfiguration) */
const THEMES = {
  dark: {
    canvas: '#1b1b19',
    label: '#f5f4f1',
    labelSecondary: 'rgba(240,239,233,0.62)',
    track: 'rgba(140,138,128,0.2)',
    accent: '#0a84ff',
  },
  light: {
    canvas: '#f3f3f0',
    label: '#131313',
    labelSecondary: 'rgba(19,19,19,0.7)',
    track: 'rgba(120,118,110,0.15)',
    accent: '#007aff',
  },
};

/** @param {unknown} theme @returns {typeof THEMES.dark} */
function palette(theme) {
  return theme === 'light' ? THEMES.light : THEMES.dark;
}

/** Background for the window itself, so the frame never flashes white. */
function themeBackground(theme) {
  return palette(theme).canvas;
}

// The platform's own UI face first, Inter as the fallback — the same stack the
// web app uses, so the wordmark does not reflow when the app takes over.
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter var',Inter,'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif";

/**
 * Shared shell: centred content on the themed canvas.
 * @param {string} theme
 * @param {string} extraCss
 * @param {string} body
 */
function chromePage(theme, extraCss, body) {
  const c = palette(theme);
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="color-scheme" content="${theme === 'light' ? 'light' : 'dark'}">` +
    '<style>' +
    `html{color-scheme:${theme === 'light' ? 'light' : 'dark'}}` +
    'body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;' +
    `font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;` +
    `background:${c.canvas};color:${c.label};}` +
    extraCss +
    '</style></head><body>' +
    body +
    '</body></html>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Shown when no serverUrl is configured — a developer-facing state. */
function noServerUrlPage(theme) {
  const c = palette(theme);
  return chromePage(
    theme,
    '.box{text-align:center;max-width:26rem;padding:2rem;}' +
      'h1{font-size:1.25rem;font-weight:600;letter-spacing:-.01em;margin:0 0 .75rem;}' +
      `p{margin:0;font-size:.9375rem;line-height:1.5;color:${c.labelSecondary};}` +
      `code{font-family:ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,monospace;font-size:.875em;color:${c.label};}`,
    '<div class="box"><h1>Server URL not configured</h1>' +
      '<p>Run from source with <code>src/config/build-config.json</code></p></div>'
  );
}

/**
 * Splash shown while the server URL loads. The bar is an indeterminate sweep,
 * not a progress reading — there is nothing to measure yet.
 */
function loadingPage(theme) {
  const c = palette(theme);
  return chromePage(
    theme,
    '.c{text-align:center}' +
      '.t{font-size:1.5rem;font-weight:600;letter-spacing:-.02em}' +
      `.b{height:2px;width:80px;margin:20px auto 0;background:${c.track};border-radius:1px;overflow:hidden}` +
      `.b::after{content:"";display:block;height:100%;width:40%;background:${c.accent};border-radius:1px;` +
      // Same standard ease the app uses for motion nothing is holding on to.
      'animation:p 1.2s cubic-bezier(0.25,0.1,0.25,1) infinite}' +
      '@keyframes p{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}' +
      '@media (prefers-reduced-motion:reduce){.b::after{animation-duration:2.4s}}',
    '<div class="c"><div class="t">TMA Cloud</div><div class="b"></div></div>'
  );
}

/** Shown when the configured server cannot be reached. */
function serverErrorPage(serverUrl, theme) {
  const c = palette(theme);
  const u = serverUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return chromePage(
    theme,
    '.box{text-align:center;max-width:26rem;padding:2rem;}' +
      'h1{font-size:1.25rem;font-weight:600;letter-spacing:-.01em;margin:0 0 .75rem;}' +
      `p{margin:0;color:${c.labelSecondary};font-size:.9375rem;line-height:1.5;}` +
      // The URL is the one piece of this screen worth reading twice, so it gets
      // full label weight against the secondary text around it.
      `strong{color:${c.label};font-weight:600;}` +
      `a{color:${c.accent};}`,
    '<div class="box"><h1>Could not connect to the server</h1>' +
      '<p>Check that your network is working and the server is running at <strong>' +
      u +
      '</strong></p>' +
      '<p style="margin-top:1rem;">You can try again by closing and reopening the app, or contact your administrator.</p></div>'
  );
}

module.exports = {
  EMBEDDED_SERVER_URL,
  EMBEDDED_UPDATOR_URL,
  getServerUrl,
  getUpdatorUrl,
  noServerUrlPage,
  loadingPage,
  serverErrorPage,
  themeBackground,
};
