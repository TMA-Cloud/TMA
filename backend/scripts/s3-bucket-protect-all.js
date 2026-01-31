/**
 * Apply all bucket protection in one run:
 *   1. Block public access (private bucket)
 *   2. Bucket policy: deny HTTP (HTTPS only)
 *   3. Enable versioning
 *   4. Enable default SSE (AES256) — skipped with a warning if not supported
 *   5. Lifecycle: abort incomplete multipart after 1 day; delete noncurrent versions after 7 days; remove delete markers
 *
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-bucket-protect-all.js
 */

const path = require('path');
const dotenv = require('dotenv');

const scriptDir = __dirname;
const backendDir = path.join(scriptDir, '..');
const projectRoot = path.join(backendDir, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(backendDir, '.env') });

const {
  S3Client,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');
const { useS3, s3: s3Config } = require('../config/storage');

const DAYS_AFTER_INITIATION = 1;
const NONCURRENT_DAYS = 7;

function createClient() {
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

async function runAll() {
  if (!useS3) {
    console.error(
      'STORAGE_DRIVER is not s3 or S3 env vars are missing. Set STORAGE_DRIVER=s3 and RUSTFS_* (or AWS_S3_*) in .env.'
    );
    process.exit(1);
  }

  const bucket = s3Config.bucket;
  const client = createClient();
  let failed = false;

  // 1. Block public access
  try {
    await client.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      })
    );
    console.log('1/5 Block public access: OK (bucket is private).');
  } catch (err) {
    console.error('1/5 Block public access: FAILED —', err.message);
    failed = true;
  }

  // 2. Bucket policy: deny HTTP (HTTPS only)
  const httpsOnlyPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
    ],
  });
  try {
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: httpsOnlyPolicy,
      })
    );
    console.log('2/5 Bucket policy (HTTPS only): OK.');
  } catch (err) {
    console.error('2/5 Bucket policy (HTTPS only): FAILED —', err.message);
    failed = true;
  }

  // 3. Enable versioning
  try {
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      })
    );
    console.log('3/5 Versioning: OK.');
  } catch (err) {
    console.error('3/5 Versioning: FAILED —', err.message);
    failed = true;
  }

  // 4. Default encryption (optional: some S3-compatible stores do not support it)
  try {
    await client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
              BucketKeyEnabled: false,
            },
          ],
        },
      })
    );
    console.log('4/5 Default encryption (SSE-S3): OK.');
  } catch (err) {
    console.warn('4/5 Default encryption: skipped (not supported or error):', err.message);
  }

  // 5. Lifecycle: abort incomplete multipart + delete old versions & delete markers
  try {
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
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
      })
    );
    console.log(
      `5/5 Lifecycle: OK (abort incomplete after ${DAYS_AFTER_INITIATION} day; delete noncurrent after ${NONCURRENT_DAYS} days; remove delete markers).`
    );
  } catch (err) {
    console.error('5/5 Lifecycle: FAILED —', err.message);
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }
  console.log(`\nBucket "${bucket}" protection applied. All done.`);
}

runAll();
