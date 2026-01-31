const { getUserStorageUsage, getUserStorageLimit } = require('../../models/user.model');
const checkDiskSpace = require('check-disk-space').default;
const { sendSuccess } = require('../../utils/response');
const { useS3 } = require('../../config/storage');

/**
 * Get storage usage information for the current user.
 * Local: total/free derived from disk and per-user limit.
 * S3: total = per-user limit or null (Unlimited); no disk; free = limit - used or null.
 */
async function storageUsage(req, res) {
  const used = await getUserStorageUsage(req.userId);
  const userStorageLimit = await getUserStorageLimit(req.userId);

  if (useS3) {
    const total = userStorageLimit !== null ? userStorageLimit : null;
    const free = userStorageLimit !== null ? Math.max(0, userStorageLimit - used) : null;
    return sendSuccess(res, { used, total, free });
  }

  const basePath = process.env.UPLOAD_DIR || process.cwd();
  const { size, free: diskFree } = await checkDiskSpace(basePath);
  const effectiveLimit = userStorageLimit !== null ? userStorageLimit : size;
  const total = Math.min(size, effectiveLimit);
  const remainingLimit = Math.max(total - used, 0);
  const free = Math.min(diskFree, remainingLimit);

  sendSuccess(res, { used, total, free });
}

module.exports = {
  storageUsage,
};
