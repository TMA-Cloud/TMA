const { checkAgentStatus } = require('./agentClient');
const { getUserCustomDrive } = require('../models/file/file.cache.model');

/**
 * Check if agent is required and online for a user's operation
 * Always performs a fresh check to avoid stale cache issues
 * @param {string} userId - User ID
 * @returns {Promise<{required: boolean, online: boolean}>}
 */
async function checkAgentForUser(userId) {
  try {
    const customDrive = await getUserCustomDrive(userId);

    // If user doesn't have custom drive enabled, agent is not required
    if (!customDrive.enabled || !customDrive.path) {
      return { required: false, online: true };
    }

    // User has custom drive - agent is REQUIRED
    // STRICT: If agent is offline, NO operations are allowed on custom drive paths
    // The backend should NEVER access custom drive paths directly - only through agent
    try {
      const isOnline = await checkAgentStatus();
      // CRITICAL: Only return true if explicitly confirmed online (strict check)
      // This prevents false positives when agent health check might succeed incorrectly
      const { logger } = require('../config/logger');
      logger.debug({ userId, isOnline, required: true }, 'Agent status check for user with custom drive');
      return {
        required: true,
        online: isOnline === true, // Only true if explicitly confirmed online
      };
    } catch (checkError) {
      // If health check fails (timeout, error), assume offline to be safe
      // This ensures we don't allow operations when agent status is unknown
      const { logger } = require('../config/logger');
      logger.warn({ err: checkError, userId }, 'Agent health check failed, blocking operations');
      return { required: true, online: false };
    }
  } catch (err) {
    // On error getting user settings, log it and assume agent not required
    // This is safe because if we can't determine custom drive status, we assume it's disabled
    const { logger } = require('../config/logger');
    logger.debug({ err, userId }, 'Error getting custom drive settings, assuming agent not required');
    return { required: false, online: true };
  }
}

module.exports = {
  checkAgentForUser,
};
