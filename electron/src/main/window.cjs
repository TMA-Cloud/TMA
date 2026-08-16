const path = require('path');
const fs = require('fs');
const { BrowserWindow, Menu, screen } = require('electron');
const { loadingPage, serverErrorPage, themeBackground } = require('./config.cjs');
const { getTheme, rememberTheme } = require('./theme.cjs');

const ELECTRON_HEADER_NAME = 'X-TMA-Desktop-Client';
const ELECTRON_HEADER_VALUE = 'tma-electron-client-v1';

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;

/**
 * @returns {import('electron').BrowserWindow | null}
 */
function getMainWindow() {
  return mainWindow;
}

/**
 * Create and show the main app window.
 * @param {string} loadUrl - URL to load (data: or http(s):)
 * @param {string} preloadPath - Absolute path to preload script
 * @param {string} appRoot - Application root (dev: project root; packaged: dir containing app.asar)
 */
function createWindow(loadUrl, preloadPath, appRoot) {
  const absolutePreload = path.isAbsolute(preloadPath) ? preloadPath : path.resolve(preloadPath);
  if (!fs.existsSync(absolutePreload)) {
    console.error('[Electron] Preload script not found:', absolutePreload);
  }

  // Packaged: files are under app.asar/dist-electron/ (icon at dist-electron/icon.png). Dev: same layout in dist-electron/.
  const iconNextToMain = path.join(__dirname, '..', 'icon.png');
  const iconInApp = path.join(appRoot, 'icon.png');
  const iconInSrcBuild = path.join(appRoot, 'src', 'build', 'icon.png');
  const iconInBuild = path.join(appRoot, 'build', 'icon.png');
  const iconPath = fs.existsSync(iconNextToMain)
    ? iconNextToMain
    : fs.existsSync(iconInApp)
      ? iconInApp
      : fs.existsSync(iconInSrcBuild)
        ? iconInSrcBuild
        : fs.existsSync(iconInBuild)
          ? iconInBuild
          : null;

  // Size window relative to the current display work area (not full screen).
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const targetWidth = Math.round(screenWidth * 0.7);
  const targetHeight = Math.round(screenHeight * 0.8);

  // Last known renderer theme.
  const theme = getTheme();

  mainWindow = new BrowserWindow({
    width: targetWidth,
    height: targetHeight,
    center: true,
    title: 'TMA Cloud',
    show: false,
    // Chromium paints this before the first frame of any document.
    backgroundColor: themeBackground(theme),
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      preload: absolutePreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Security: restrict navigation to the expected origin only
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(new URL(loadUrl).origin)) event.preventDefault();
  });

  // Security: block all window.open() calls
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Security: deny all permission requests (camera, mic, etc.) by default
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const isServerUrl = loadUrl && !loadUrl.startsWith('data:');

  if (isServerUrl) {
    // Inject a custom header into all requests from this window to the server URL.
    // The backend can use this to distinguish Electron desktop traffic from normal browsers.
    try {
      const serverOrigin = new URL(loadUrl).origin;
      const ses = mainWindow.webContents.session;
      // Use a wildcard filter and re-validate the origin inside the callback
      // so we never rely on glob prefix matching, which can be fooled when
      // the expected origin is a prefix of an attacker-controlled host.
      // Exact origin equality is the only trusted signal.
      ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
        // Wrap the whole body so that any unexpected throw still results in
        // the callback firing — otherwise the request hangs indefinitely.
        try {
          let sameOrigin;
          try {
            sameOrigin = new URL(details.url).origin === serverOrigin;
          } catch {
            sameOrigin = false;
          }
          if (!sameOrigin) {
            callback({ requestHeaders: details.requestHeaders });
            return;
          }
          const requestHeaders = {
            ...details.requestHeaders,
            [ELECTRON_HEADER_NAME]: ELECTRON_HEADER_VALUE,
          };
          callback({ requestHeaders });
        } catch (err) {
          console.warn('[Electron] webRequest header injection failed:', err && err.message ? err.message : err);
          try {
            callback({ requestHeaders: details.requestHeaders });
          } catch {
            /* callback already called or request aborted */
          }
        }
      });
    } catch {
      // If URL parsing fails, skip header injection
    }

    mainWindow.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      const a = (loadUrl || '').replace(/\/$/, '');
      const b = (validatedURL || '').replace(/\/$/, '');
      if (a !== b && b.indexOf(a) !== 0 && a.indexOf(b) !== 0) return;
      mainWindow.loadURL(serverErrorPage(loadUrl, theme));
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isServerUrl) {
    mainWindow.loadURL(loadingPage(theme));
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      setTimeout(() => mainWindow.loadURL(loadUrl), 120);
    });
  } else {
    mainWindow.loadURL(loadUrl);
    mainWindow.once('ready-to-show', () => mainWindow.show());
  }

  mainWindow.webContents.on('did-finish-load', () => {
    // Mirror the web app's theme choice for the next launch's splash.
    if (isServerUrl && !mainWindow.webContents.getURL().startsWith('data:')) {
      mainWindow.webContents
        .executeJavaScript('localStorage.getItem("theme")')
        .then(rememberTheme)
        .catch(() => {
          /* storage unavailable; keep the last known theme */
        });
    }

    mainWindow.webContents
      .executeJavaScript('typeof window.electronAPI !== "undefined"')
      .then(hasAPI => {
        if (!hasAPI) {
          console.warn(
            '[Electron] window.electronAPI is missing in the loaded page. Desktop-only features will not appear.'
          );
        }
      })
      .catch(err => {
        console.warn('[Electron] Failed to probe window.electronAPI:', err && err.message ? err.message : err);
      });
  });
}

module.exports = { createWindow, getMainWindow };
