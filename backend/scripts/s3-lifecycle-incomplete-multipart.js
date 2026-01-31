/**
 * Apply bucket lifecycle rules:
 *   1. Abort incomplete multipart uploads after 1 day.
 *   2. Delete old versions after 7 days and remove delete markers (versioning cleanup).
 *
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-lifecycle-incomplete-multipart.js
 */

const path = require('path');
const dotenv = require('dotenv');

const scriptDir = __dirname;
const backendDir = path.join(scriptDir, '..');
const projectRoot = path.join(backendDir, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(backendDir, '.env') });

const { S3Client, PutBucketLifecycleConfigurationCommand } = require('@aws-sdk/client-s3');
const { useS3, s3: s3Config } = require('../config/storage');

const DAYS_AFTER_INITIATION = 1;
const NONCURRENT_DAYS = 7;

async function applyLifecycle() {
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

  const lifecycle = {
    Bucket: s3Config.bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'AbortIncompleteMultipartUploads',
          Status: 'Enabled',
          Filter: {},
          AbortIncompleteMultipartUpload: {
            DaysAfterInitiation: DAYS_AFTER_INITIATION,
          },
        },
        {
          ID: 'DeleteOldVersions',
          Status: 'Enabled',
          Filter: {},
          NoncurrentVersionExpiration: {
            NoncurrentDays: NONCURRENT_DAYS,
          },
          Expiration: {
            ExpiredObjectDeleteMarker: true,
          },
        },
      ],
    },
  };

  try {
    await client.send(new PutBucketLifecycleConfigurationCommand(lifecycle));
    console.log(`Lifecycle rules applied on bucket "${s3Config.bucket}":`);
    console.log(`  - Abort incomplete multipart uploads after ${DAYS_AFTER_INITIATION} day(s).`);
    console.log(`  - Delete noncurrent versions after ${NONCURRENT_DAYS} days; remove expired delete markers.`);
  } catch (err) {
    console.error('Failed to apply lifecycle configuration:', err.message);
    process.exit(1);
  }
}

applyLifecycle();
