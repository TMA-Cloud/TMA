/**
 * Enable default server-side encryption (SSE-S3 / AES256) on the S3/RUSTFS bucket.
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 * Note: Some S3-compatible stores (e.g. MinIO/RUSTFS) may not support this; script will report and exit 1.
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-bucket-encryption.js
 */

import '../config/env.js';

import { PutBucketEncryptionCommand } from '@aws-sdk/client-s3';

import { createS3Client, s3Config } from './s3Utils.js';

async function enableEncryption() {
  const client = createS3Client();

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
