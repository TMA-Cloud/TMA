const { getUserStorageUsage, getUserStorageLimit } = require('../../models/user.model');
const checkDiskSpace = require('check-disk-space').default;
const { sendSuccess } = require('../../utils/response');

/**
 * Get storage usage information for the current user.
 */
async function storageUsage(req, res) {
  const used = await getUserStorageUsage(req.userId);
  const basePath = process.env.UPLOAD_DIR || process.cwd();
  const { size, free: diskFree } = await checkDiskSpace(basePath);

  const userStorageLimit = await getUserStorageLimit(req.userId);
  const effectiveLimit = userStorageLimit !== null ? userStorageLimit : size;

  const total = Math.min(size, effectiveLimit);
  const remainingLimit = Math.max(total - used, 0);
  const free = Math.min(diskFree, remainingLimit);

  sendSuccess(res, { used, total, free });
}

module.exports = {
  storageUsage,
};
