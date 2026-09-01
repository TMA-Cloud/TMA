/**
 * Local filesystem storage driver.
 * Uses UPLOAD_DIR; key is the relative path (e.g. "abc123.pdf").
 */

import fs from 'fs';
import path from 'path';

import { UPLOAD_DIR } from '../config/paths.js';

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

/**
 * Open a read stream for a stored object, optionally limited to a byte range.
 * @param {string} key
 * @param {{ start?: number, end?: number }} [range] - Inclusive byte range
 * @returns {Promise<import('stream').Readable>}
 */
async function getReadStream(key, range) {
  const p = resolveKey(key);
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    return fs.createReadStream(p, { start: range.start, end: range.end });
  }
  return fs.createReadStream(p);
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
  const writeStream = fs.createWriteStream(dest);
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

/**
 * List files in UPLOAD_DIR page-by-page with their size and mtime.
 * Mirrors the S3 driver's listObjectsPaginated so the orphan scanner can treat
 * both drivers the same way. Only top-level entries are listed, matching how
 * storage keys are written.
 * @param {number} [pageSize=1000]
 * @yields {Array<{ key: string, size: number, lastModified: Date | null }>}
 */
async function* listObjectsPaginated(pageSize = 1000) {
  let entries;
  try {
    entries = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  let page = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    let stats;
    try {
      stats = await fs.promises.stat(path.join(UPLOAD_DIR, entry.name));
    } catch {
      continue; // Removed between readdir and stat
    }
    page.push({ key: entry.name, size: stats.size, lastModified: stats.mtime });
    if (page.length >= pageSize) {
      yield page;
      page = [];
    }
  }
  if (page.length > 0) yield page;
}

/**
 * Read a stored file's size and mtime.
 * @param {string} key - Storage key
 * @returns {Promise<{ size: number, lastModified: Date | null } | null>} null when the file is gone
 */
async function statObject(key) {
  try {
    const stats = await fs.promises.stat(resolveKey(key));
    return { size: stats.size, lastModified: stats.mtime };
  } catch {
    return null;
  }
}

export {
  exists,
  getReadStream,
  putFromPath,
  putBuffer,
  putStream,
  deleteObject,
  copyObject,
  listObjectsPaginated,
  statObject,
  resolveKey,
};
