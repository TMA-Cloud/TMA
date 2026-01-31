/**
 * Storage configuration for local disk or S3-compatible object storage (e.g. AWS S3).
 * Set STORAGE_DRIVER=s3 and RUSTFS_* or AWS_* env vars for S3.
 */

const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';

// S3: support RUSTFS_* or AWS_* env vars
const S3_ENDPOINT = process.env.RUSTFS_ENDPOINT || process.env.AWS_S3_ENDPOINT;
const S3_BUCKET = process.env.RUSTFS_BUCKET || process.env.AWS_S3_BUCKET;
const S3_ACCESS_KEY = process.env.RUSTFS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
const S3_SECRET_KEY = process.env.RUSTFS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const S3_REGION = process.env.RUSTFS_REGION || process.env.AWS_REGION || 'us-east-1';
const S3_FORCE_PATH_STYLE = process.env.RUSTFS_FORCE_PATH_STYLE !== 'false';

const useS3 = STORAGE_DRIVER === 's3' && S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY;

module.exports = {
  STORAGE_DRIVER,
  useS3,
  s3: {
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    region: S3_REGION,
    forcePathStyle: S3_FORCE_PATH_STYLE,
  },
};
