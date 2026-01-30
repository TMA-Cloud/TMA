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
 * Get actual disk size for a path (total size in bytes).
 * @param {string} basePath - Path to check (e.g. UPLOAD_DIR)
 * @returns {Promise<number>} Total disk size in bytes
 */
async function getActualDiskSize(basePath) {
  const checkDiskSpace = require('check-disk-space').default;
  const { size } = await checkDiskSpace(basePath);
  return size;
}

/**
 * Check if file size would exceed storage limit
 * @param {Object} params - Parameters
 * @param {number} fileSize - File size in bytes
 * @param {number} used - Currently used storage
 * @param {number} userStorageLimit - User's storage limit (null = use actual disk)
 * @param {string} defaultBasePath - Default base path
 * @returns {Promise<{exceeded: boolean, message?: string}>}
 */
async function checkStorageLimitExceeded({ fileSize, used, userStorageLimit }) {
  if (userStorageLimit === null) {
    return { exceeded: false }; // No limit set
  }

  const newTotal = used + fileSize;

  if (newTotal > userStorageLimit) {
    const usedFormatted = formatFileSize(used);
    const limitFormatted = formatFileSize(userStorageLimit);
    const availableFormatted = formatFileSize(Math.max(0, userStorageLimit - used));
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
  checkStorageLimitExceeded,
};
