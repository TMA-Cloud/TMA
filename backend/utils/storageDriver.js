/**
 * Storage driver facade: local disk or S3-compatible (e.g. AWS S3/RustFS).
 * Use this module for all file storage operations.
 */

const { useS3 } = require('../config/storage');
const s3Storage = require('./s3Storage');
const localStorage = require('./localStorage');

function getDriver() {
  return useS3 ? s3Storage : localStorage;
}

async function exists(key) {
  return getDriver().exists(key);
}

async function getReadStream(key) {
  return getDriver().getReadStream(key);
}

async function putFromPath(key, localPath) {
  return getDriver().putFromPath(key, localPath);
}

async function putBuffer(key, buffer) {
  return getDriver().putBuffer(key, buffer);
}

async function putStream(key, stream, contentLength) {
  const driver = getDriver();
  if (driver.putStream.length >= 3 && contentLength != null) {
    return driver.putStream(key, stream, contentLength);
  }
  return driver.putStream(key, stream);
}

async function deleteObject(key) {
  return getDriver().deleteObject(key);
}

async function copyObject(sourceKey, destKey) {
  return getDriver().copyObject(sourceKey, destKey);
}

/**
 * List all keys (S3 only; local returns [] for compatibility)
 * @returns {Promise<string[]>}
 */
async function listKeys() {
  const driver = getDriver();
  if (driver.listKeys) return driver.listKeys();
  return [];
}

/**
 * List keys page-by-page (S3 only; avoids loading entire bucket into RAM).
 * @param {number} [pageSize=1000]
 * @returns {AsyncGenerator<string[], void, void>}
 */
function listKeysPaginated(pageSize = 1000) {
  const driver = getDriver();
  if (driver.listKeysPaginated) return driver.listKeysPaginated(pageSize);
  return (async function* () {})();
}

/** For local driver only: resolve key to absolute path (for encryption/decryption that need paths) */
function resolveKeyToPath(key) {
  if (useS3) return null;
  return localStorage.resolveKey(key);
}

module.exports = {
  useS3: () => useS3,
  exists,
  getReadStream,
  putFromPath,
  putBuffer,
  putStream,
  deleteObject,
  copyObject,
  listKeys,
  listKeysPaginated,
  resolveKeyToPath,
  getDriver,
};
