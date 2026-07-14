/*
 * Builds the native WinFsp filesystem host (desktop-fs) as a self-contained
 * win-x64 executable and stages it under electron/clouddrive-dist/, which
 * electron-builder then bundles into resources/clouddrive/ (see the
 * extraResources entry in the electron-builder configs).
 *
 * Self-contained means the target machine does NOT need the .NET runtime
 * installed. WinFsp itself (the kernel driver) is still a prerequisite and is
 * handled by the NSIS installer include (see build/installer.nsh).
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const electronDir = path.join(__dirname, '..');
const repoRoot = path.join(electronDir, '..');
const fsProject = path.join(repoRoot, 'desktop-fs', 'TmaCloudFs.csproj');
const publishDir = path.join(repoRoot, 'desktop-fs', 'bin', 'publish');
const stageDir = path.join(electronDir, 'clouddrive-dist');

// WinFsp redistributable (kernel driver installer) bundled into the app and
// run silently by the NSIS installer if WinFsp is not already present.
const WINFSP = {
  asset: path.join(electronDir, 'build-assets', 'winfsp.msi'),
  url: 'https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi',
  sha256: '073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a',
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          res.resume();
          return resolve(download(res.headers.location, dest, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureWinFspMsi() {
  fs.mkdirSync(path.dirname(WINFSP.asset), { recursive: true });
  const ok = fs.existsSync(WINFSP.asset) && sha256(WINFSP.asset) === WINFSP.sha256;
  if (!ok) {
    console.log('[build-clouddrive] fetching WinFsp redistributable...');
    await download(WINFSP.url, WINFSP.asset);
    const got = sha256(WINFSP.asset);
    if (got !== WINFSP.sha256) throw new Error('WinFsp MSI hash mismatch: ' + got);
  }
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  if (!fs.existsSync(fsProject)) {
    console.warn('[build-clouddrive] desktop-fs project not found; skipping cloud drive bundle.');
    return;
  }

  console.log('[build-clouddrive] publishing self-contained win-x64 host...');
  execFileSync(
    'dotnet',
    [
      'publish',
      fsProject,
      '-c',
      'Release',
      '-r',
      'win-x64',
      '--self-contained',
      'true',
      '/p:PublishSingleFile=false',
      '-o',
      publishDir,
    ],
    { stdio: 'inherit' }
  );

  // Stage a clean copy for electron-builder to pick up.
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });
  copyRecursive(publishDir, stageDir);

  const exe = path.join(stageDir, 'TmaCloudFs.exe');
  if (!fs.existsSync(exe)) {
    throw new Error('TmaCloudFs.exe missing from publish output.');
  }

  // Bundle the WinFsp installer so the NSIS setup can install the driver.
  await ensureWinFspMsi();
  fs.copyFileSync(WINFSP.asset, path.join(stageDir, 'winfsp.msi'));

  console.log('[build-clouddrive] staged cloud drive host + winfsp.msi at', stageDir);
}

main().catch(err => {
  console.error('[build-clouddrive] ERROR:', err.message);
  process.exit(1);
});
