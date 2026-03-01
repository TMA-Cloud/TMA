/**
 * S3-compatible storage driver (e.g. AWS S3/RustFS). Uses @aws-sdk/client-s3.
 */

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { createReadStream } = require('fs');
const { logger } = require('../config/logger');
const { useS3, s3: s3Config } = require('../config/storage');

let s3Client = null;

function getClient() {
  if (!useS3) return null;
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
  if (!client) return false;
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
 * Get a readable stream for the object
 * @param {string} key - Object key
 * @returns {Promise<Readable>}
 */
async function getReadStream(key) {
  const client = getClient();
  if (!client) throw new Error('S3 client not configured');
  const response = await client.send(
    new GetObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
    })
  );
  return response.Body;
}

/**
 * Upload from a local file path (e.g. after encryption)
 * @param {string} key - Object key
 * @param {string} localPath - Path to local file
 * @returns {Promise<void>}
 */
async function putFromPath(key, localPath) {
  const client = getClient();
  if (!client) throw new Error('S3 client not configured');
  const body = createReadStream(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: body,
    })
  );
}

/**
 * Upload from buffer
 * @param {string} key - Object key
 * @param {Buffer} buffer - File content
 * @returns {Promise<void>}
 */
async function putBuffer(key, buffer) {
  const client = getClient();
  if (!client) throw new Error('S3 client not configured');
  await client.send(
    new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: buffer,
    })
  );
}

/**
 * Upload from stream (unknown length: use Upload/multipart to avoid x-amz-decoded-content-length).
 * @param {string} key - Object key
 * @param {import('stream').Readable} stream - Readable stream
 * @param {number} [contentLength] - Optional content length (if known, uses PutObject; else Upload)
 * @returns {Promise<void>}
 */
async function putStream(key, stream, contentLength) {
  const client = getClient();
  if (!client) throw new Error('S3 client not configured');

  if (contentLength != null && contentLength >= 0) {
    await client.send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: stream,
        ContentLength: contentLength,
      })
    );
    return;
  }

  const upload = new Upload({
    client,
    params: {
      Bucket: s3Config.bucket,
      Key: key,
      Body: stream,
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
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
  if (!client) throw new Error('S3 client not configured');
  await client.send(
    new DeleteObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
    })
  );
}

/**
 * Copy object to new key (same bucket)
 * @param {string} sourceKey - Source object key
 * @param {string} destKey - Destination object key
 * @returns {Promise<void>}
 */
async function copyObject(sourceKey, destKey) {
  const client = getClient();
  if (!client) throw new Error('S3 client not configured');
  await client.send(
    new CopyObjectCommand({
      Bucket: s3Config.bucket,
      CopySource: `${s3Config.bucket}/${encodeURIComponent(sourceKey)}`,
      Key: destKey,
    })
  );
}

/**
 * List all object keys in the bucket (for orphan cleanup).
 * Avoids loading the whole bucket into memory by processing page-by-page.
 * @returns {Promise<string[]>}
 */
async function listKeys() {
  const client = getClient();
  if (!client) return [];
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
  if (!client) return;
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

module.exports = {
  exists,
  getReadStream,
  putFromPath,
  putBuffer,
  putStream,
  deleteObject,
  copyObject,
  listKeys,
  listKeysPaginated,
  isEnabled: () => useS3,
};
