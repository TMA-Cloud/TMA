/*
 * Drive access mode, set by the first user on the server for every desktop app.
 *   'full'     - files can be opened/read from the drive
 *   'saveOnly' - browse + Save-As only; reading file content is denied
 * Until the server answers the drive is save-only, so a failed read never opens it up.
 */
const { getCookieHeader, getJson } = require('../utils/file-utils.cjs');

const DEFAULT_MODE = 'saveOnly';
const FETCH_TIMEOUT_MS = 10000;

/** The server's mode, or null when it could not be read. */
async function fetchServerMode(base) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), FETCH_TIMEOUT_MS);
  });
  try {
    const cookieHeader = await getCookieHeader(base);
    const data = await Promise.race([getJson(`${base}/api/user/cloud-drive-config`, cookieHeader), timeout]);
    if (data && data.saveOnly === false) return 'full';
    if (data && data.saveOnly === true) return 'saveOnly';
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DEFAULT_MODE, fetchServerMode };
