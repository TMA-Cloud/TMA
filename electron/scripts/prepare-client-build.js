const fs = require('fs');
const path = require('path');

// Run from electron/; paths relative to electron folder
const electronDir = path.join(__dirname, '..');
const buildConfigPath = path.join(electronDir, 'configs', 'build-config.json');
const distDir = path.join(electronDir, 'dist-electron');

let serverUrl = '';
if (fs.existsSync(buildConfigPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(buildConfigPath, 'utf8'));
    if (data.serverUrl) serverUrl = data.serverUrl;
  } catch (_) {
    // ignore
  }
}
if (!serverUrl) {
  console.warn(
    "WARNING: electron/configs/build-config.json missing or has no serverUrl. Built app will show 'Server URL not configured'."
  );
}

// Clean and create staging dir
if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

for (const name of ['main.cjs', 'preload.cjs']) {
  fs.copyFileSync(path.join(electronDir, name), path.join(distDir, name));
}
const iconSrc = path.join(electronDir, 'build', 'icon.png');
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, path.join(distDir, 'icon.png'));
}

const mainPath = path.join(distDir, 'main.cjs');
let main = fs.readFileSync(mainPath, 'utf8');
const escaped = serverUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
main = main.replace(/const EMBEDDED_SERVER_URL = '';/, `const EMBEDDED_SERVER_URL = '${escaped}';`);
fs.writeFileSync(mainPath, main, 'utf8');

console.log('Client build staging done. serverUrl from configs/build-config.json embedded in main.cjs.');
