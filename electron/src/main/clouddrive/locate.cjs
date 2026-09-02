/*
 * Locate the compiled WinFsp host exe in both dev and packaged layouts.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function locateFsExe() {
  const candidates = [
    process.env.TMA_CLOUDFS_EXE,
    app && app.isPackaged ? path.join(process.resourcesPath, 'clouddrive', 'TmaCloudFs.exe') : null,
    // dev: repo-root/desktop-fs/bin/Release/TmaCloudFs.exe
    path.join(__dirname, '..', '..', '..', '..', 'desktop-fs', 'bin', 'Release', 'TmaCloudFs.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

module.exports = { locateFsExe };
