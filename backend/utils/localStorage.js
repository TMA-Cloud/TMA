/**
 * Local filesystem storage driver.
 * Uses UPLOAD_DIR; key is the relative path (e.g. "abc123.pdf").
 */

const fs = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const { UPLOAD_DIR } = require('../config/paths');

function resolveKey(key) {
  if (!key) throw new Error('Storage key is required');
  const filePath = path.join(UPLOAD_DIR, key);
  const resolvedUploadDir = path.resolve(UPLOAD_DIR);
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(resolvedUploadDir)) {
    throw new Error('Invalid storage key: path traversal detected');
  }
  return resolvedFilePath;
}

async function exists(key) {
  try {
    const p = resolveKey(key);
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function getReadStream(key) {
  const p = resolveKey(key);
  return createReadStream(p);
}

async function putFromPath(key, localPath) {
  const dest = resolveKey(key);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(localPath, dest);
}

async function putBuffer(key, buffer) {
  const dest = resolveKey(key);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buffer);
}

async function putStream(key, stream) {
  const dest = resolveKey(key);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const writeStream = require('fs').createWriteStream(dest);
  await new Promise((resolve, reject) => {
    stream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    stream.on('error', reject);
  });
}

async function deleteObject(key) {
  const p = resolveKey(key);
  await fs.promises.unlink(p);
}

async function copyObject(sourceKey, destKey) {
  const src = resolveKey(sourceKey);
  const dest = resolveKey(destKey);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(src, dest);
}

module.exports = {
  exists,
  getReadStream,
  putFromPath,
  putBuffer,
  putStream,
  deleteObject,
  copyObject,
  resolveKey,
};
