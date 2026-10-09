/**
 * Apply a bucket policy that denies all requests over HTTP (enforces HTTPS).
 * Uses the storage bucket configured in Settings > Storage.
 *
 * Note: PutBucketPolicy replaces the entire bucket policy. If you have other
 * policy statements, merge them in the RUSTFS UI or extend this script.
 *
 * Usage: from backend dir, with .env pointing at the database:
 *   node scripts/s3-bucket-policy-https.js
 */

import '../config/env.js';

import { PutBucketPolicyCommand } from '@aws-sdk/client-s3';

import { openBucket } from './s3Utils.js';

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
  const { client, bucket } = await openBucket();

  const policy = getHttpsOnlyPolicy(bucket);

  try {
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: policy,
      })
    );
    console.log(`Bucket policy applied on "${bucket}": all requests must use HTTPS (HTTP denied).`);
  } catch (err) {
    console.error('Failed to apply bucket policy:', err.message);
    process.exit(1);
  }
}

applyHttpsPolicy();
