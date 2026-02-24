const fs = require('fs');
const path = require('path');

// Run from electron/; paths relative to electron folder
const electronDir = path.join(__dirname, '..');
const buildConfigPath = path.join(electronDir, 'src', 'config', 'build-config.json');
const distDir = path.join(electronDir, 'dist-electron');
const srcDir = path.join(electronDir, 'src');

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
    "WARNING: electron/src/config/build-config.json missing or has no serverUrl. Built app will show 'Server URL not configured'."
  );
}

// Clean and create staging dir
if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

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

// Copy main process and preload (industry-standard src layout)
copyRecursive(path.join(srcDir, 'main'), path.join(distDir, 'main'));
copyRecursive(path.join(srcDir, 'preload'), path.join(distDir, 'preload'));

// Icon at app root for packaged app (window icon at runtime)
const iconSrc = path.join(electronDir, 'src', 'build', 'icon.png');
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, path.join(distDir, 'icon.png'));
}

// Embed server URL in main process config (packaged app uses this; dev uses src/config/build-config.json)
const configPath = path.join(distDir, 'main', 'config.cjs');
let config = fs.readFileSync(configPath, 'utf8');
const escaped = serverUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
config = config.replace(/const EMBEDDED_SERVER_URL = '';/, `const EMBEDDED_SERVER_URL = '${escaped}';`);
fs.writeFileSync(configPath, config, 'utf8');

console.log('Client build staging done. serverUrl from src/config/build-config.json embedded in main/config.cjs.');
