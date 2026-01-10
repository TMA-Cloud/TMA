/**
 * Storage utility functions
 */

/**
 * Format bytes to human-readable string
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size (e.g., "1.5 MB")
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Get actual disk size for a user (checks custom drive if enabled)
 * @param {Object} customDrive - Custom drive settings {enabled, path}
 * @param {string} defaultBasePath - Default base path for disk space check
 * @returns {Promise<number>} Actual disk size in bytes
 */
async function getActualDiskSize(customDrive, defaultBasePath) {
  const checkDiskSpace = require('check-disk-space').default;

  if (customDrive.enabled && customDrive.path) {
    const { size } = await checkDiskSpace(customDrive.path);
    return size;
  }

  const { size } = await checkDiskSpace(defaultBasePath);
  return size;
}

/**
 * Get effective storage limit for a user
 * @param {number|null} userStorageLimit - User's custom storage limit (null = use actual disk)
 * @param {number} actualDiskSize - Actual disk size
 * @returns {number} Effective limit
 */
function getEffectiveLimit(userStorageLimit, actualDiskSize) {
  return userStorageLimit !== null ? userStorageLimit : actualDiskSize;
}

/**
 * Check if file size would exceed storage limit
 * @param {Object} params - Parameters
 * @param {number} fileSize - File size in bytes
 * @param {Object} customDrive - Custom drive settings
 * @param {number} used - Currently used storage
 * @param {number} userStorageLimit - User's storage limit (null = use actual disk)
 * @param {string} defaultBasePath - Default base path
 * @returns {Promise<{exceeded: boolean, message?: string}>}
 */
async function checkStorageLimitExceeded({ fileSize, customDrive, used, userStorageLimit, defaultBasePath }) {
  const checkDiskSpace = require('check-disk-space').default;

  if (customDrive.enabled && customDrive.path) {
    // For custom drives, check actual free disk space
    const { free: diskFree } = await checkDiskSpace(customDrive.path);
    if (fileSize > diskFree) {
      return { exceeded: true, message: 'Storage limit exceeded. Not enough space on custom drive.' };
    }
    return { exceeded: false };
  }

  // For regular uploads, check against user's storage limit
  const { size } = await checkDiskSpace(defaultBasePath);
  const effectiveLimit = getEffectiveLimit(userStorageLimit, size);
  const newTotal = used + fileSize;

  if (newTotal > effectiveLimit) {
    const usedFormatted = formatFileSize(used);
    const limitFormatted = formatFileSize(effectiveLimit);
    const availableFormatted = formatFileSize(Math.max(0, effectiveLimit - used));
    return {
      exceeded: true,
      message: `Storage limit exceeded. You have used ${usedFormatted} of ${limitFormatted}. ${availableFormatted} available.`,
    };
  }

  return { exceeded: false };
}

module.exports = {
  formatFileSize,
  getActualDiskSize,
  getEffectiveLimit,
  checkStorageLimitExceeded,
};
