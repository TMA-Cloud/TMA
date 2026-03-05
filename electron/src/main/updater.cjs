const path = require('path');
const fs = require('fs');
const { net, shell, app } = require('electron');
const { getUpdatorUrl } = require('./config.cjs');

/** URL = <updatorUrl>/v<version> (version trimmed, leading "v" stripped so no double v). */
function getInstallFileUrl(updatorUrl, version) {
  const base = updatorUrl.replace(/\/$/, '');
  const v = String(version).trim().replace(/^v/i, '');
  return `${base}/v${v}`;
}

/**
 * Parse filename from Content-Disposition header.
 * @param {string} contentDisposition
 * @returns {string | null}
 */
function parseFilenameFromContentDisposition(contentDisposition) {
  if (!contentDisposition || typeof contentDisposition !== 'string') return null;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;,\s]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quoted = contentDisposition.match(/filename="([^"]+)"/);
  if (quoted && quoted[1]) return quoted[1];
  const unquoted = contentDisposition.match(/filename=([^;,\s]+)/);
  if (unquoted && unquoted[1]) return unquoted[1].trim();
  return null;
}

/**
 * Default installer filename for Windows.
 */
function getDefaultInstallerFilename(version) {
  return `TMA-Cloud-Setup-${version}.exe`;
}

/**
 * Download the installer from <updatorUrl>/v<version> and run it.
 * @param {string} version - Latest version tag from the feed (e.g. "1.0.3" or "v1.0.3")
 * @param {(percent: number) => void} [onProgress] - Optional; called with 0-100 when Content-Length is known
 * @returns {{ ok: boolean; error?: string }}
 */
async function downloadAndInstallUpdate(version, onProgress) {
  const updatorUrl = getUpdatorUrl();
  if (!updatorUrl) {
    return {
      ok: false,
      error: 'Updator URL is not configured. Set updatorUrl in electron/src/config/build-config.json.',
    };
  }
  if (!version || typeof version !== 'string') {
    return { ok: false, error: 'Version is required.' };
  }
  const trimmedVersion = version.trim();
  if (!trimmedVersion) {
    return { ok: false, error: 'Version is required.' };
  }

  const installUrl = getInstallFileUrl(updatorUrl, trimmedVersion);

  try {
    const response = await net.fetch(installUrl, { redirect: 'follow' });
    if (!response.ok) {
      const msg = `Download failed: ${response.status} ${response.statusText}. Tried: ${installUrl}`;
      return { ok: false, error: msg };
    }

    const contentDisposition = response.headers.get('Content-Disposition');
    const suggestedName =
      parseFilenameFromContentDisposition(contentDisposition) || getDefaultInstallerFilename(trimmedVersion);
    const safeName = suggestedName.replace(/[^\w.-]/g, '_');
    const tempDir = app.getPath('temp');
    const tempPath = path.join(tempDir, `tma-cloud-update-${Date.now()}-${safeName}`);

    const total = parseInt(response.headers.get('Content-Length') || '0', 10) || 0;
    let received = 0;
    let lastPercent = -1;
    const reader = response.body.getReader();
    const writeStream = fs.createWriteStream(tempPath, { flags: 'w' });

    const streamFinished = new Promise((resolve, reject) => {
      writeStream.once('finish', resolve);
      writeStream.once('error', reject);
    });

    const writeChunk = chunk =>
      new Promise((resolve, reject) => {
        const ok = writeStream.write(chunk, err => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else writeStream.once('drain', resolve);
      });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) await writeChunk(value);
        received += value?.length ?? 0;
        if (typeof onProgress === 'function' && total > 0) {
          const percent = Math.min(100, Math.round((received / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress(percent);
          }
        }
      }
      writeStream.end();
      await streamFinished;
    } catch (streamErr) {
      writeStream.destroy();
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
      throw streamErr;
    }

    const openResult = await shell.openPath(tempPath);
    if (openResult) {
      return { ok: false, error: openResult || 'Failed to launch installer.' };
    }
    // Delay quit so the installer process can start and show its window before we exit
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: message };
  }
}

module.exports = {
  downloadAndInstallUpdate,
};
