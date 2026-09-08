import { S3Client } from '@aws-sdk/client-s3';

import { s3 as s3Config } from '../config/storage.js';

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

export { createS3Client, s3Config, buildLifecycleRules, DAYS_AFTER_INITIATION, NONCURRENT_DAYS };
