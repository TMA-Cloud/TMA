/**
 * Block all public access on the S3/RUSTFS bucket (private bucket).
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-bucket-public-access-block.js
 */

import '../config/env.js';

import { PutPublicAccessBlockCommand, S3Client } from '@aws-sdk/client-s3';

import { s3 as s3Config, useS3 } from '../config/storage.js';

async function blockPublicAccess() {
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
      new PutPublicAccessBlockCommand({
        Bucket: s3Config.bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      })
    );
    console.log(
      `Public access blocked on bucket "${s3Config.bucket}". Bucket is private (only your credentials can access).`
    );
  } catch (err) {
    console.error('Failed to set public access block:', err.message);
    process.exit(1);
  }
}

blockPublicAccess();
