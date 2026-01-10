/**
 * File cleanup utility functions
 */
const fs = require('fs').promises;
const { logger } = require('../config/logger');

/**
 * Safely delete a file, ignoring errors
 * @param {string} filePath - Path to file to delete
 * @param {Object} options - Options
 * @param {boolean} options.logErrors - Whether to log errors (default: false)
 * @returns {Promise<void>}
 */
async function safeUnlink(filePath, options = {}) {
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch (error) {
    // Only log if explicitly requested (for debugging)
    if (options.logErrors) {
      logger.warn({ filePath, error: error.message }, 'Failed to delete file during cleanup');
    }
    // Silently ignore cleanup errors (file might not exist, already deleted, etc.)
  }
}

module.exports = {
  safeUnlink,
};
