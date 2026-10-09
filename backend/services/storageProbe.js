/**
 * Proves a candidate storage configuration works before it is saved: the
 * bucket is reachable, the key can list, write, read back and delete, and (when
 * files already exist) the target still holds them.
 */

import crypto from 'crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { logger } from '../config/logger.js';

const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_PREFIX = '.tma-cloud-probe/';

class StorageProbeError extends Error {
  constructor(step, message) {
    super(message);
    this.name = 'StorageProbeError';
    this.step = step;
    this.status = 422;
  }
}

function probeClient(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: config.forcePathStyle,
    // Fail fast: the admin is waiting on this request and retries only repeat a misconfiguration.
    maxAttempts: 1,
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  });
}

/** Map an SDK failure to a message that helps the admin without echoing provider internals. */
function describeFailure(err, bucket) {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.Code || err?.name;
  if (code === 'NoSuchBucket' || (status === 404 && code !== 'NoSuchKey')) {
    return `Bucket "${bucket}" was not found at this endpoint`;
  }
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken'].includes(code)) {
    return 'The access key ID or secret access key was rejected';
  }
  // HEAD responses carry no error code, so a bad key and a missing permission look the same.
  if (status === 403 || code === 'AccessDenied') {
    return "Access denied: check the access key ID, the secret and the key's permissions on this bucket";
  }
  if (code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed' || status === 301) {
    return 'The bucket is in a different region; check the region setting';
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH'].includes(err?.code)) {
    return 'Could not connect to the endpoint';
  }
  if (err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') return 'The endpoint did not respond in time';
  if (/certificate|self[- ]signed|SSL|TLS/i.test(err?.message || '')) {
    return 'The endpoint TLS certificate is not trusted';
  }
  return 'The storage endpoint returned an unexpected error';
}

async function step(name, bucket, action) {
  try {
    return await action();
  } catch (err) {
    if (err instanceof StorageProbeError) throw err;
    logger.warn(
      { step: name, code: err?.Code || err?.name, status: err?.$metadata?.httpStatusCode },
      '[Storage] Probe failed'
    );
    throw new StorageProbeError(name, describeFailure(err, bucket));
  }
}

// The probe object is 32 bytes; a misbehaving endpoint must not make the server buffer more.
const MAX_PROBE_BODY_BYTES = 64 * 1024;

async function readBody(body) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_PROBE_BODY_BYTES) {
      body.destroy?.();
      throw new StorageProbeError('read', 'An object read back differently from how it was written');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Run every check against a configuration that has not been saved yet.
 * @param {object} config - Normalised storage settings including the secret
 * @param {{ sampleKeys?: string[] }} [options] - Existing object keys the target must hold
 * @returns {Promise<{ checks: string[] }>}
 * @throws {StorageProbeError}
 */
async function probeStorage(config, { sampleKeys = [] } = {}) {
  const client = probeClient(config);
  const Bucket = config.bucket;
  const checks = [];
  try {
    await step('connect', Bucket, () => client.send(new HeadBucketCommand({ Bucket })));
    checks.push('connect');

    await step('list', Bucket, () => client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 })));
    checks.push('list');

    const Key = `${PROBE_PREFIX}${crypto.randomUUID()}`;
    const payload = crypto.randomBytes(32);
    await step('write', Bucket, () =>
      client.send(new PutObjectCommand({ Bucket, Key, Body: payload, ContentLength: payload.length }))
    );
    checks.push('write');
    try {
      await step('read', Bucket, async () => {
        const response = await client.send(new GetObjectCommand({ Bucket, Key }));
        if (!payload.equals(await readBody(response.Body))) {
          throw new StorageProbeError('read', 'An object read back differently from how it was written');
        }
      });
      checks.push('read');
    } finally {
      await step('delete', Bucket, () => client.send(new DeleteObjectCommand({ Bucket, Key })));
    }
    checks.push('delete');

    if (sampleKeys.length > 0) {
      const found = await Promise.all(
        sampleKeys.map(key =>
          client
            .send(new HeadObjectCommand({ Bucket, Key: key }))
            .then(() => true)
            .catch(() => false)
        )
      );
      // Any hit proves this is the same store; zero means the files would all go missing.
      if (!found.some(Boolean)) {
        throw new StorageProbeError(
          'existing-files',
          'This bucket does not contain the files already stored. Copy them across before switching.'
        );
      }
      checks.push('existing-files');
    }
    return { checks };
  } finally {
    client.destroy();
  }
}

export { StorageProbeError, probeStorage };
