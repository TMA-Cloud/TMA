/**
 * Apply bucket lifecycle rules:
 *   1. Abort incomplete multipart uploads after 1 day.
 *   2. Delete old versions after 7 days and remove delete markers (versioning cleanup).
 *
 * The rules themselves live in s3Utils.js so this script and
 * s3-bucket-protect-all.js always write the same policy.
 *
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-lifecycle-incomplete-multipart.js
 */

import '../config/env.js';

import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

import { createS3Client, s3Config, buildLifecycleRules, DAYS_AFTER_INITIATION, NONCURRENT_DAYS } from './s3Utils.js';

async function applyLifecycle() {
  const client = createS3Client();

  try {
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: s3Config.bucket,
        LifecycleConfiguration: { Rules: buildLifecycleRules() },
      })
    );
    console.log(`Lifecycle rules applied on bucket "${s3Config.bucket}":`);
    console.log(`  - Abort incomplete multipart uploads after ${DAYS_AFTER_INITIATION} day(s).`);
    console.log(`  - Delete noncurrent versions after ${NONCURRENT_DAYS} days; remove expired delete markers.`);
  } catch (err) {
    console.error('Failed to apply lifecycle configuration:', err.message);
    process.exit(1);
  }
}

applyLifecycle();
