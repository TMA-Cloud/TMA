const path = require('path');
const fs = require('fs');
const { BrowserWindow, Menu } = require('electron');
const { LOADING_PAGE, serverErrorPage } = require('./config.cjs');

/**
 * Create and show the main app window.
 * @param {string} loadUrl - URL to load (data: or http(s):)
 * @param {string} preloadPath - Absolute path to preload script
 * @param {string} appRoot - Application root (icons: appRoot/icon.png packaged, appRoot/src/build/icon.png dev)
 */
function createWindow(loadUrl, preloadPath, appRoot) {
  const absolutePreload = path.isAbsolute(preloadPath) ? preloadPath : path.resolve(preloadPath);
  if (!fs.existsSync(absolutePreload)) {
    console.error('[Electron] Preload script not found:', absolutePreload);
  }

  const iconInApp = path.join(appRoot, 'icon.png');
  const iconInSrcBuild = path.join(appRoot, 'src', 'build', 'icon.png');
  const iconInBuild = path.join(appRoot, 'build', 'icon.png');
  const iconPath = fs.existsSync(iconInApp)
    ? iconInApp
    : fs.existsSync(iconInSrcBuild)
      ? iconInSrcBuild
      : fs.existsSync(iconInBuild)
        ? iconInBuild
        : null;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'TMA Cloud',
    show: false,
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      preload: absolutePreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);

  const isServerUrl = loadUrl && !loadUrl.startsWith('data:');

  if (isServerUrl) {
    win.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      const a = (loadUrl || '').replace(/\/$/, '');
      const b = (validatedURL || '').replace(/\/$/, '');
      if (a !== b && b.indexOf(a) !== 0 && a.indexOf(b) !== 0) return;
      win.loadURL(serverErrorPage(loadUrl));
    });
  }

  if (isServerUrl) {
    win.loadURL(LOADING_PAGE);
    win.once('ready-to-show', () => {
      win.show();
      setTimeout(() => win.loadURL(loadUrl), 120);
    });
  } else {
    win.loadURL(loadUrl);
    win.once('ready-to-show', () => win.show());
  }

  win.webContents.on('did-finish-load', () => {
    win.webContents
      .executeJavaScript('typeof window.electronAPI !== "undefined"')
      .then(hasAPI => {
        if (!hasAPI) {
          console.warn(
            '[Electron] window.electronAPI is missing in the loaded page. Desktop-only features will not appear.'
          );
        }
      })
      .catch(() => {});
  });
}

module.exports = { createWindow };
