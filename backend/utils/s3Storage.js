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

import { logger } from '../config/logger.js';
import { getS3Config } from '../config/storage.js';
import { MAX_MAX_UPLOAD_BYTES } from '../config/uploadLimits.js';
import { plaintextSizeToCiphertextSize } from './fileEncryption.js';
import {
  DEFAULT_COPY_PART_SIZE,
  DEFAULT_UPLOAD_PART_SIZE,
  multipartPartSizeFor,
  requiresMultipart,
} from './storageSizing.js';

const MAX_ENCRYPTED_UPLOAD_BYTES = plaintextSizeToCiphertextSize(MAX_MAX_UPLOAD_BYTES);

const RETIRED_CLIENT_GRACE_MS = 5 * 60 * 1000;

let active = null;

/** An S3 client for one storage configuration. */
function createS3Client(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * The client and bucket for the current configuration. A new configuration
 * gets a new client; the old one is closed after a grace period so transfers
 * already running on it can finish.
 * @returns {Promise<{ client: S3Client, bucket: string }>}
 */
async function getStore() {
  const config = await getS3Config();
  if (active?.version !== config.version) {
    const retired = active?.client;
    if (retired) setTimeout(() => retired.destroy(), RETIRED_CLIENT_GRACE_MS).unref();
    active = { version: config.version, client: createS3Client(config), bucket: config.bucket };
  }
  return active;
}

/**
 * Check if object exists
 * @param {string} key - Object key (same as DB path, e.g. "abc123.pdf")
 * @returns {Promise<boolean>}
 */
async function exists(key) {
  const { client, bucket } = await getStore();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
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
  const { client, bucket } = await getStore();
  const params = {
    Bucket: bucket,
    Key: key,
  };
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    params.Range = `bytes=${range.start}-${range.end}`;
  }
  const response = await client.send(new GetObjectCommand(params));
  return response.Body;
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
  const { client, bucket } = await getStore();
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
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: exactLength,
      })
    );
    return;
  }

  const sizeHint = exactLength ?? Number(maximumLength);
  const partSize = multipartPartSizeFor(sizeHint, DEFAULT_UPLOAD_PART_SIZE);
  const params = { Bucket: bucket, Key: key, Body: body };
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
  const { client, bucket } = await getStore();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

/** Delete up to any number of objects using S3's 1,000-key batch API. */
async function deleteObjects(keys) {
  const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
  if (uniqueKeys.length === 0) return { deleted: [], errors: [] };

  const { client, bucket } = await getStore();
  const deleted = [];
  const errors = [];
  for (let offset = 0; offset < uniqueKeys.length; offset += 1000) {
    const chunk = uniqueKeys.slice(offset, offset + 1000);
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
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
  const { client, bucket } = await getStore();
  const source = `${bucket}/${encodeURIComponent(sourceKey)}`;
  const size = Number(sourceSize);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError('Multipart copy source size must be a positive safe integer');
  }
  const partSize = multipartPartSizeFor(size, DEFAULT_COPY_PART_SIZE);
  const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: destKey }));
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
              Bucket: bucket,
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
        Bucket: bucket,
        Key: destKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  } catch (error) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: destKey, UploadId: uploadId }))
      .catch(abortError => logger.warn({ err: abortError, destKey }, '[S3] Failed to abort multipart copy'));
    throw error;
  }
}

async function copyObject(sourceKey, destKey, knownSourceSize) {
  const { client, bucket } = await getStore();
  const source = `${bucket}/${encodeURIComponent(sourceKey)}`;
  let sourceSize = Number(knownSourceSize);
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 0) {
    const sourceMetadata = await statObject(sourceKey);
    if (!sourceMetadata) throw Object.assign(new Error('Source object not found'), { name: 'NoSuchKey' });
    sourceSize = sourceMetadata.size;
  }

  if (!requiresMultipart(sourceSize)) {
    await client.send(new CopyObjectCommand({ Bucket: bucket, CopySource: source, Key: destKey }));
    return;
  }
  await multipartCopyObject(sourceKey, destKey, sourceSize);
}

/**
 * List objects page-by-page with their size and last-modified time.
 * Streams rather than loading every key into memory, and carries the metadata
 * the orphan scanner needs to tell a stale leftover from a fresh upload.
 * @param {number} [pageSize=1000]
 * @yields {Array<{ key: string, size: number, lastModified: Date | null }>}
 */
async function* listObjectsPaginated(pageSize = 1000) {
  const { client, bucket } = await getStore();
  let continuationToken;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
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
  const { client, bucket } = await getStore();
  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
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
  createS3Client,
  exists,
  getReadStream,
  putBuffer,
  putStream,
  deleteObject,
  deleteObjects,
  copyObject,
  multipartCopyObject,
  listObjectsPaginated,
  statObject,
};
