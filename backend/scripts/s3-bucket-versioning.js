/**
 * Enable versioning on the S3/RUSTFS bucket.
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-bucket-versioning.js
 */

import '../config/env.js';

import { PutBucketVersioningCommand } from '@aws-sdk/client-s3';

import { createS3Client, requireS3Config, s3Config } from './s3Utils.js';

async function enableVersioning() {
  requireS3Config();

  const client = createS3Client();

  try {
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: s3Config.bucket,
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      })
    );
    console.log(`Versioning enabled on bucket "${s3Config.bucket}".`);
  } catch (err) {
    console.error('Failed to enable versioning:', err.message);
    process.exit(1);
  }
}

enableVersioning();
