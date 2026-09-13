/**
 * S3-compatible storage driver (e.g. AWS S3/RustFS). Uses @aws-sdk/client-s3.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';

import { logger } from '../config/logger.js';
import { s3 as s3Config } from '../config/storage.js';
import { MAX_MAX_UPLOAD_BYTES } from '../config/uploadLimits.js';
import { plaintextSizeToCiphertextSize } from './fileEncryption.js';
import {
  DEFAULT_COPY_PART_SIZE,
  DEFAULT_UPLOAD_PART_SIZE,
  multipartPartSizeFor,
  requiresMultipart,
} from './storageSizing.js';

const MAX_ENCRYPTED_UPLOAD_BYTES = plaintextSizeToCiphertextSize(MAX_MAX_UPLOAD_BYTES);

let s3Client = null;

function getClient() {
  if (s3Client) return s3Client;
  s3Client = new S3Client({
    endpoint: s3Config.endpoint,
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
    forcePathStyle: s3Config.forcePathStyle,
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return s3Client;
}

/**
 * Check if object exists
 * @param {string} key - Object key (same as DB path, e.g. "abc123.pdf")
 * @returns {Promise<boolean>}
 */
async function exists(key) {
  const client = getClient();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
      })
    );
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    logger.warn({ err, key }, '[S3] HeadObject failed');
    throw err;
  }
}

/**
 * Get a readable stream for the object, optionally limited to a byte range.
 * A ranged GET only transfers the requested ciphertext bytes, which is what lets
 * a segmented download serve an HTTP Range without fetching the whole object.
 * @param {string} key - Object key
 * @param {{ start?: number, end?: number }} [range] - Inclusive byte range
 * @returns {Promise<Readable>}
 */
async function getReadStream(key, range) {
  const client = getClient();
  const params = {
    Bucket: s3Config.bucket,
    Key: key,
  };
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    params.Range = `bytes=${range.start}-${range.end}`;
  }
  const response = await client.send(new GetObjectCommand(params));
  return response.Body;
}

/**
 * Upload from a local file path (e.g. after encryption)
 * @param {string} key - Object key
 * @param {string} localPath - Path to local file
 * @returns {Promise<void>}
 */
async function putFromPath(key, localPath) {
  const { size } = await fs.promises.stat(localPath);
  const body = fs.createReadStream(localPath);
  await putStream(key, body, size);
}

/**
 * Upload from buffer
 * @param {string} key - Object key
 * @param {Buffer} buffer - File content
 * @returns {Promise<void>}
 */
async function putBuffer(key, buffer) {
  await putStream(key, buffer, buffer.byteLength);
}

/**
 * Upload a body using a portable single request when possible and multipart
 * otherwise. Unknown-length streams use the largest application object as the
 * sizing hint so they cannot unexpectedly run through S3/R2's 10,000-part cap.
 * @param {string} key - Object key
 * @param {import('stream').Readable|Buffer|Uint8Array} body - Upload body
 * @param {number} [contentLength] - Exact byte length, when known
 * @param {number} [maximumLength] - Upper bound for an unknown-length body
 * @returns {Promise<void>}
 */
async function putStream(key, body, contentLength, maximumLength = MAX_ENCRYPTED_UPLOAD_BYTES) {
  const client = getClient();
  let exactLength;
  if (contentLength != null) {
    exactLength = Number(contentLength);
    if (!Number.isSafeInteger(exactLength) || exactLength < 0) {
      throw new TypeError('Content length must be a non-negative safe integer');
    }
  }

  if (exactLength != null && !requiresMultipart(exactLength)) {
    await client.send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: body,
        ContentLength: exactLength,
      })
    );
    return;
  }

  const sizeHint = exactLength ?? Number(maximumLength);
  const partSize = multipartPartSizeFor(sizeHint, DEFAULT_UPLOAD_PART_SIZE);
  const params = { Bucket: s3Config.bucket, Key: key, Body: body };
  if (exactLength != null) params.ContentLength = exactLength;
  const upload = new Upload({
    client,
    params,
    queueSize: 4,
    partSize,
    leavePartsOnError: false,
  });
  await upload.done();
}

/**
 * Delete object
 * @param {string} key - Object key
 * @returns {Promise<void>}
 */
async function deleteObject(key) {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
    })
  );
}

/** Delete up to any number of objects using S3's 1,000-key batch API. */
async function deleteObjects(keys) {
  const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
  if (uniqueKeys.length === 0) return { deleted: [], errors: [] };

  const client = getClient();
  const deleted = [];
  const errors = [];
  for (let offset = 0; offset < uniqueKeys.length; offset += 1000) {
    const chunk = uniqueKeys.slice(offset, offset + 1000);
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: s3Config.bucket,
        Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
      })
    );
    const chunkErrors = response.Errors || [];
    const failedKeys = new Set(chunkErrors.map(error => error.Key));
    deleted.push(...chunk.filter(key => !failedKeys.has(key)));
    errors.push(...chunkErrors);
  }
  return { deleted, errors };
}

/**
 * Copy object to new key (same bucket)
 * @param {string} sourceKey - Source object key
 * @param {string} destKey - Destination object key
 * @returns {Promise<void>}
 */
async function multipartCopyObject(sourceKey, destKey, sourceSize) {
  const client = getClient();
  const source = `${s3Config.bucket}/${encodeURIComponent(sourceKey)}`;
  const size = Number(sourceSize);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError('Multipart copy source size must be a positive safe integer');
  }
  const partSize = multipartPartSizeFor(size, DEFAULT_COPY_PART_SIZE);
  const created = await client.send(new CreateMultipartUploadCommand({ Bucket: s3Config.bucket, Key: destKey }));
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error('Object store did not return a multipart upload id');

  try {
    const ranges = [];
    for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber += 1) {
      const end = Math.min(start + partSize, size) - 1;
      ranges.push({ start, end, partNumber });
    }
    const parts = [];
    let next = 0;
    let firstError = null;
    const workers = Array.from({ length: Math.min(4, ranges.length) }, async () => {
      while (!firstError && next < ranges.length) {
        const { start, end, partNumber } = ranges[next++];
        try {
          const copied = await client.send(
            new UploadPartCopyCommand({
              Bucket: s3Config.bucket,
              Key: destKey,
              UploadId: uploadId,
              PartNumber: partNumber,
              CopySource: source,
              CopySourceRange: `bytes=${start}-${end}`,
            })
          );
          const ETag = copied.CopyPartResult?.ETag;
          if (!ETag) throw new Error(`Object store did not return an ETag for copied part ${partNumber}`);
          parts.push({ ETag, PartNumber: partNumber });
        } catch (error) {
          firstError ||= error;
        }
      }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
    parts.sort((a, b) => a.PartNumber - b.PartNumber);
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: s3Config.bucket,
        Key: destKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  } catch (error) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: s3Config.bucket, Key: destKey, UploadId: uploadId }))
      .catch(abortError => logger.warn({ err: abortError, destKey }, '[S3] Failed to abort multipart copy'));
    throw error;
  }
}

async function copyObject(sourceKey, destKey, knownSourceSize) {
  const client = getClient();
  const source = `${s3Config.bucket}/${encodeURIComponent(sourceKey)}`;
  let sourceSize = Number(knownSourceSize);
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 0) {
    const sourceMetadata = await statObject(sourceKey);
    if (!sourceMetadata) throw Object.assign(new Error('Source object not found'), { name: 'NoSuchKey' });
    sourceSize = sourceMetadata.size;
  }

  if (!requiresMultipart(sourceSize)) {
    await client.send(new CopyObjectCommand({ Bucket: s3Config.bucket, CopySource: source, Key: destKey }));
    return;
  }
  await multipartCopyObject(sourceKey, destKey, sourceSize);
}

/**
 * List all object keys in the bucket (for orphan cleanup).
 * Avoids loading the whole bucket into memory by processing page-by-page.
 * @returns {Promise<string[]>}
 */
async function listKeys() {
  const client = getClient();
  const keys = [];
  let continuationToken;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    );
    for (const obj of response.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/**
 * List object keys page-by-page (for orphan cleanup at scale; avoids loading all keys into RAM).
 * @param {number} [pageSize=1000]
 * @yields {string[]} One page of keys per iteration
 */
async function* listKeysPaginated(pageSize = 1000) {
  const client = getClient();
  let continuationToken;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        ContinuationToken: continuationToken,
        MaxKeys: pageSize,
      })
    );
    const page = (response.Contents || []).map(obj => obj.Key).filter(Boolean);
    if (page.length > 0) yield page;
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * List objects page-by-page with their size and last-modified time.
 * Same streaming behaviour as listKeysPaginated, but carries the metadata the
 * orphan scanner needs to tell a stale leftover from a fresh upload.
 * @param {number} [pageSize=1000]
 * @yields {Array<{ key: string, size: number, lastModified: Date | null }>}
 */
async function* listObjectsPaginated(pageSize = 1000) {
  const client = getClient();
  let continuationToken;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        ContinuationToken: continuationToken,
        MaxKeys: pageSize,
      })
    );
    const page = (response.Contents || [])
      .filter(obj => obj.Key)
      .map(obj => ({
        key: obj.Key,
        size: typeof obj.Size === 'number' ? obj.Size : 0,
        lastModified: obj.LastModified ? new Date(obj.LastModified) : null,
      }));
    if (page.length > 0) yield page;
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Read an object's size and last-modified time without downloading it.
 * @param {string} key - Object key
 * @returns {Promise<{ size: number, lastModified: Date | null } | null>} null when the object is gone
 */
async function statObject(key) {
  const client = getClient();
  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
      })
    );
    return {
      size: typeof response.ContentLength === 'number' ? response.ContentLength : 0,
      lastModified: response.LastModified ? new Date(response.LastModified) : null,
    };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    logger.warn({ err, key }, '[S3] HeadObject failed');
    throw err;
  }
}

export {
  exists,
  getReadStream,
  putFromPath,
  putBuffer,
  putStream,
  deleteObject,
  deleteObjects,
  copyObject,
  multipartCopyObject,
  listKeys,
  listKeysPaginated,
  listObjectsPaginated,
  statObject,
};
