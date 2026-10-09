/**
 * Check current bucket lifecycle configuration.
 * Usage: node scripts/check-s3-lifecycle.js
 */
import '../config/env.js';

import { GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

import { openBucket } from './s3Utils.js';

async function checkLifecycle() {
  const { client, bucket } = await openBucket();
  try {
    const data = await client.send(
      new GetBucketLifecycleConfigurationCommand({
        Bucket: bucket,
      })
    );

    console.log('Current Lifecycle Configuration:');
    console.log(JSON.stringify(data.Rules, null, 2));
  } catch (err) {
    if (err.name === 'NoSuchLifecycleConfiguration') {
      console.log('❌ No lifecycle rules are currently set on this bucket.');
    } else {
      console.error('❌ Error fetching configuration:', err.message);
    }
  }
}

checkLifecycle();
