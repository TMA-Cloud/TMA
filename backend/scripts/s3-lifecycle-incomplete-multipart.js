/**
 * Apply bucket lifecycle rules:
 *   1. Abort incomplete multipart uploads after 1 day.
 *   2. Delete old versions after 7 days and remove delete markers (versioning cleanup).
 *
 * The rules themselves live in s3Utils.js so this script and
 * s3-bucket-protect-all.js always write the same policy.
 *
 * Uses the storage bucket configured in Settings > Storage.
 *
 * Usage: from backend dir, with .env pointing at the database:
 *   node scripts/s3-lifecycle-incomplete-multipart.js
 */

import '../config/env.js';

import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

import { openBucket, buildLifecycleRules, DAYS_AFTER_INITIATION, NONCURRENT_DAYS } from './s3Utils.js';

async function applyLifecycle() {
  const { client, bucket } = await openBucket();

  try {
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: { Rules: buildLifecycleRules() },
      })
    );
    console.log(`Lifecycle rules applied on bucket "${bucket}":`);
    console.log(`  - Abort incomplete multipart uploads after ${DAYS_AFTER_INITIATION} day(s).`);
    console.log(`  - Delete noncurrent versions after ${NONCURRENT_DAYS} days; remove expired delete markers.`);
  } catch (err) {
    console.error('Failed to apply lifecycle configuration:', err.message);
    process.exit(1);
  }
}

applyLifecycle();
