/**
 * Check current bucket lifecycle configuration.
 * Usage: node scripts/check-s3-lifecycle.js
 */
const path = require('path');
const dotenv = require('dotenv');

const scriptDir = __dirname;
const backendDir = path.join(scriptDir, '..');
const projectRoot = path.join(backendDir, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(backendDir, '.env') });

const { S3Client, GetBucketLifecycleConfigurationCommand } = require('@aws-sdk/client-s3');
const { s3: s3Config } = require('../config/storage');

const client = new S3Client({
  endpoint: s3Config.endpoint,
  region: s3Config.region,
  credentials: {
    accessKeyId: s3Config.accessKeyId,
    secretAccessKey: s3Config.secretAccessKey,
  },
  forcePathStyle: s3Config.forcePathStyle,
});

async function checkLifecycle() {
  try {
    const data = await client.send(
      new GetBucketLifecycleConfigurationCommand({
        Bucket: s3Config.bucket,
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
