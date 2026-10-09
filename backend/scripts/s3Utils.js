import pool from '../config/db.js';
import { getS3Config } from '../config/storage.js';
import { createS3Client } from '../utils/s3Storage.js';

/**
 * The client and bucket for the storage configured in Settings. The database
 * pool is closed once the config is read, so a script exits when its S3 work ends.
 * @returns {Promise<{ client: import('@aws-sdk/client-s3').S3Client, bucket: string }>}
 */
async function openBucket() {
  try {
    const config = await getS3Config();
    return { client: createS3Client(config), bucket: config.bucket };
  } finally {
    await pool.end();
  }
}

/**
 * Lifecycle policy applied to the bucket. Both the standalone lifecycle script
 * and the all-in-one hardening script write this same configuration, so it is
 * defined once here to keep them from drifting apart.
 */
const DAYS_AFTER_INITIATION = 1;
const NONCURRENT_DAYS = 7;

function buildLifecycleRules() {
  return [
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
  ];
}

export { openBucket, buildLifecycleRules, DAYS_AFTER_INITIATION, NONCURRENT_DAYS };
