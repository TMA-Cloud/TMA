/**
 * Storage driver facade: local disk or S3-compatible (e.g. AWS S3/RustFS).
 * Use this module for all file storage operations.
 */

import { useS3 as useS3Enabled } from '../config/storage.js';

import * as localStorage from './localStorage.js';
import * as s3Storage from './s3Storage.js';

function getDriver() {
  return useS3Enabled ? s3Storage : localStorage;
}

async function exists(key) {
  return getDriver().exists(key);
}

async function getReadStream(key, range) {
  return getDriver().getReadStream(key, range);
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

/**
 * List objects page-by-page with size and last-modified time (both drivers).
 * @param {number} [pageSize=1000]
 * @returns {AsyncGenerator<Array<{ key: string, size: number, lastModified: Date | null }>, void, void>}
 */
function listObjectsPaginated(pageSize = 1000) {
  const driver = getDriver();
  if (driver.listObjectsPaginated) return driver.listObjectsPaginated(pageSize);
  return (async function* () {})();
}

/**
 * Read an object's size and last-modified time.
 * @param {string} key
 * @returns {Promise<{ size: number, lastModified: Date | null } | null>} null when the object is gone
 */
async function statObject(key) {
  const driver = getDriver();
  if (!driver.statObject) return null;
  return driver.statObject(key);
}

/** For local driver only: resolve key to absolute path (for encryption/decryption that need paths) */
function resolveKeyToPath(key) {
  if (useS3Enabled) return null;
  return localStorage.resolveKey(key);
}

function useS3() {
  return useS3Enabled;
}

export {
  useS3,
  exists,
  getReadStream,
  putFromPath,
  putBuffer,
  putStream,
  deleteObject,
  copyObject,
  listKeys,
  listKeysPaginated,
  listObjectsPaginated,
  statObject,
  resolveKeyToPath,
  getDriver,
};

export default {
  useS3,
  exists,
  getReadStream,
  putFromPath,
  putBuffer,
  putStream,
  deleteObject,
  copyObject,
  listKeys,
  listKeysPaginated,
  listObjectsPaginated,
  statObject,
  resolveKeyToPath,
  getDriver,
};
