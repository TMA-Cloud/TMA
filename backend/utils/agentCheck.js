const { checkAgentStatus } = require('./agentClient');
const { getUserCustomDrive } = require('../models/user.model');

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
      return {
        required: true,
        online: isOnline === true, // Only true if explicitly confirmed online
      };
    } catch (checkError) {
      // If health check fails (timeout, error), assume offline to be safe
      // This ensures we don't allow operations when agent status is unknown
      const { logger } = require('../config/logger');
      logger.warn({ err: checkError }, 'Agent health check failed, blocking operations');
      return { required: true, online: false };
    }
  } catch (_err) {
    // On error getting user settings, assume agent not required
    return { required: false, online: true };
  }
}

module.exports = {
  checkAgentForUser,
};
