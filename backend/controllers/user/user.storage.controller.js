const { getUserStorageUsage, getUserCustomDriveSettings, getUserStorageLimit } = require('../../models/user.model');
const checkDiskSpace = require('check-disk-space').default;
const { sendSuccess } = require('../../utils/response');
const { agentGetDiskUsage } = require('../../utils/agentFileOperations');

/**
 * Get storage usage information for the current user
 */
async function storageUsage(req, res) {
  // Check if user has custom drive enabled
  const customDrive = await getUserCustomDriveSettings(req.userId);

  if (customDrive.enabled && customDrive.path) {
    // For custom drives, use agent API to get actual disk space from the mounted volume
    // This ensures we get the real size of the custom drive, not the Docker host's size
    const { total: size, free: diskFree } = await agentGetDiskUsage(customDrive.path);

    // Get per-user storage limit (null means use actual disk size as limit)
    const userStorageLimit = await getUserStorageLimit(req.userId);

    // If a custom limit is set, use database-tracked usage; otherwise use actual disk usage
    if (userStorageLimit !== null) {
      // Custom limit is set - use database-tracked usage (only files in our system)
      const used = await getUserStorageUsage(req.userId);
      const total = userStorageLimit;
      const remainingLimit = Math.max(total - used, 0);
      const free = remainingLimit;

      sendSuccess(res, { used, total, free });
    } else {
      // No custom limit - use actual disk usage (reflects real disk usage)
      const total = size;
      const used = size - diskFree;
      const free = diskFree;

      sendSuccess(res, { used, total, free });
    }
  } else {
    // Original logic for regular uploads
    const used = await getUserStorageUsage(req.userId);
    // Use upload directory or current directory as base path for disk space calculation
    const basePath = process.env.UPLOAD_DIR || __dirname;
    const { size, free: diskFree } = await checkDiskSpace(basePath);

    // Get per-user storage limit (null means use actual disk size as limit)
    const userStorageLimit = await getUserStorageLimit(req.userId);
    // If no custom limit is set, use the actual available disk space
    const effectiveLimit = userStorageLimit !== null ? userStorageLimit : size;

    const total = Math.min(size, effectiveLimit);
    const remainingLimit = Math.max(total - used, 0);
    const free = Math.min(diskFree, remainingLimit);
    sendSuccess(res, { used, total, free });
  }
}

module.exports = {
  storageUsage,
};
