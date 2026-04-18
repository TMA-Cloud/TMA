import { S3Client } from '@aws-sdk/client-s3';

import { s3 as s3Config, useS3 } from '../config/storage.js';

/**
 * Build a new S3Client using the project's storage config.
 */
function createS3Client() {
  return new S3Client({
    endpoint: s3Config.endpoint,
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
    forcePathStyle: s3Config.forcePathStyle,
  });
}

/**
 * Fail fast when the env is not configured for S3.
 * Scripts call this at the top of their main async function.
 */
function requireS3Config() {
  if (!useS3) {
    console.error(
      'STORAGE_DRIVER is not s3 or S3 env vars are missing. Set STORAGE_DRIVER=s3 and RUSTFS_* (or AWS_S3_*) in .env.'
    );
    process.exit(1);
  }
}

export { createS3Client, requireS3Config, s3Config };
