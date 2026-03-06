/**
 * Enable default server-side encryption (SSE-S3 / AES256) on the S3/RUSTFS bucket.
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 * Note: Some S3-compatible stores (e.g. MinIO/RUSTFS) may not support this; script will report and exit 1.
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-bucket-encryption.js
 */

import '../config/env.js';

import { PutBucketEncryptionCommand, S3Client } from '@aws-sdk/client-s3';

import { s3 as s3Config, useS3 } from '../config/storage.js';

async function enableEncryption() {
  if (!useS3) {
    console.error(
      'STORAGE_DRIVER is not s3 or S3 env vars are missing. Set STORAGE_DRIVER=s3 and RUSTFS_* (or AWS_S3_*) in .env.'
    );
    process.exit(1);
  }

  const client = new S3Client({
    endpoint: s3Config.endpoint,
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
    forcePathStyle: s3Config.forcePathStyle,
  });

  try {
    await client.send(
      new PutBucketEncryptionCommand({
        Bucket: s3Config.bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
              BucketKeyEnabled: false,
            },
          ],
        },
      })
    );
    console.log(`Default encryption (SSE-S3 / AES256) enabled on bucket "${s3Config.bucket}".`);
  } catch (err) {
    console.error(
      'Failed to set bucket encryption:',
      err.message,
      '\n(Some S3-compatible stores do not support PutBucketEncryption; you can skip this or enable encryption in the RUSTFS UI.)'
    );
    process.exit(1);
  }
}

enableEncryption();
