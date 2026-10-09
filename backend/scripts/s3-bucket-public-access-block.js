/**
 * Block all public access on the storage bucket (private bucket).
 * Uses the storage bucket configured in Settings > Storage.
 *
 * Usage: from backend dir, with .env pointing at the database:
 *   node scripts/s3-bucket-public-access-block.js
 */

import '../config/env.js';

import { PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';

import { openBucket } from './s3Utils.js';

async function blockPublicAccess() {
  const { client, bucket } = await openBucket();

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
    console.log(`Public access blocked on bucket "${bucket}". Bucket is private (only your credentials can access).`);
  } catch (err) {
    console.error('Failed to set public access block:', err.message);
    process.exit(1);
  }
}

blockPublicAccess();
