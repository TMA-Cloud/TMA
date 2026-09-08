/**
 * Block all public access on the S3/RUSTFS bucket (private bucket).
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-bucket-public-access-block.js
 */

import '../config/env.js';

import { PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';

import { createS3Client, s3Config } from './s3Utils.js';

async function blockPublicAccess() {
  const client = createS3Client();

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
