/**
 * Enable versioning on the storage bucket.
 * Uses the storage bucket configured in Settings > Storage.
 *
 * Usage: from backend dir, with .env pointing at the database:
 *   node scripts/s3-bucket-versioning.js
 */

import '../config/env.js';

import { PutBucketVersioningCommand } from '@aws-sdk/client-s3';

import { openBucket } from './s3Utils.js';

async function enableVersioning() {
  const { client, bucket } = await openBucket();

  try {
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      })
    );
    console.log(`Versioning enabled on bucket "${bucket}".`);
  } catch (err) {
    console.error('Failed to enable versioning:', err.message);
    process.exit(1);
  }
}

enableVersioning();
