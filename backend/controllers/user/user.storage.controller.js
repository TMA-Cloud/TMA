const { getUserStorageUsage, getUserCustomDriveSettings } = require('../../models/user.model');
const checkDiskSpace = require('check-disk-space').default;
const { sendError, sendSuccess } = require('../../utils/response');

const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT || 100 * 1024 * 1024 * 1024);

/**
 * Get storage usage information for the current user
 */
async function storageUsage(req, res) {
  try {
    // Check if user has custom drive enabled
    const customDrive = await getUserCustomDriveSettings(req.userId);

    if (customDrive.enabled && customDrive.path) {
      // Get disk space information for the user's custom drive path
      const { size, free: diskFree } = await checkDiskSpace(customDrive.path);

      // Total is the actual disk size available on the custom drive path
      const total = size;

      // Free space is the actual free space on the disk
      const free = diskFree;

      // Used space is calculated from actual disk usage (total - free)
      // This reflects the real disk usage, not just database-tracked files
      const used = total - free;

      sendSuccess(res, { used, total, free });
    } else {
      // Original logic for regular uploads
      const used = await getUserStorageUsage(req.userId);
      const { size, free: diskFree } = await checkDiskSpace(process.env.STORAGE_PATH || __dirname);
      const total = Math.min(size, STORAGE_LIMIT);
      const remainingLimit = Math.max(total - used, 0);
      const free = Math.min(diskFree, remainingLimit);
      sendSuccess(res, { used, total, free });
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  storageUsage,
};
