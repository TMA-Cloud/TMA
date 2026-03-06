/**
 * Storage configuration for local disk or S3-compatible object storage.
 * Supports: Cloudflare R2 (R2_*), RustFS/other S3 (RUSTFS_*), AWS S3 (AWS_*).
 * Set STORAGE_DRIVER=s3 and the appropriate env vars for your provider.
 */

const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';

// Cloudflare R2: R2_ACCOUNT_ID + R2_BUCKET + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY
// Or set R2_ENDPOINT to override the default https://<ACCOUNT_ID>.r2.cloudflarestorage.com
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ENDPOINT = process.env.R2_ENDPOINT || (R2_ACCOUNT_ID && `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || null;
const isR2 = Boolean((R2_ENDPOINT || R2_ACCOUNT_ID) && R2_BUCKET && R2_ACCESS_KEY && R2_SECRET_KEY);

// S3-compatible: R2, RUSTFS_* or AWS_*
const S3_ENDPOINT = R2_ENDPOINT || process.env.RUSTFS_ENDPOINT || process.env.AWS_S3_ENDPOINT;
const S3_BUCKET = R2_BUCKET || process.env.RUSTFS_BUCKET || process.env.AWS_S3_BUCKET;
const S3_ACCESS_KEY = R2_ACCESS_KEY || process.env.RUSTFS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
const S3_SECRET_KEY = R2_SECRET_KEY || process.env.RUSTFS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const S3_REGION = isR2 ? 'auto' : process.env.RUSTFS_REGION || process.env.AWS_REGION || 'us-east-1';
const S3_FORCE_PATH_STYLE = isR2 ? false : process.env.RUSTFS_FORCE_PATH_STYLE !== 'false';

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
  r2PublicUrl: R2_PUBLIC_URL,
};
