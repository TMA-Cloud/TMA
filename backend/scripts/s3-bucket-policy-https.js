/**
 * Apply a bucket policy that denies all requests over HTTP (enforces HTTPS).
 * Uses project S3 config (RUSTFS_* or AWS_* env vars).
 *
 * Note: PutBucketPolicy replaces the entire bucket policy. If you have other
 * policy statements, merge them in the RUSTFS UI or extend this script.
 *
 * Usage: from backend dir, with .env set for S3:
 *   node scripts/s3-bucket-policy-https.js
 */

const path = require('path');
const dotenv = require('dotenv');

const scriptDir = __dirname;
const backendDir = path.join(scriptDir, '..');
const projectRoot = path.join(backendDir, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(backendDir, '.env') });

const { S3Client, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');
const { useS3, s3: s3Config } = require('../config/storage');

function getHttpsOnlyPolicy(bucketName) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
        Condition: {
          Bool: {
            'aws:SecureTransport': 'false',
          },
        },
      },
    ],
  });
}

async function applyHttpsPolicy() {
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

  const policy = getHttpsOnlyPolicy(s3Config.bucket);

  try {
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: s3Config.bucket,
        Policy: policy,
      })
    );
    console.log(`Bucket policy applied on "${s3Config.bucket}": all requests must use HTTPS (HTTP denied).`);
  } catch (err) {
    console.error('Failed to apply bucket policy:', err.message);
    process.exit(1);
  }
}

applyHttpsPolicy();
