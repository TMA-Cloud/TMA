/**
 * Utility functions for detecting agent-related errors
 */

const AGENT_ERROR_PATTERNS = [
  'failed to connect to agent',
  'agent request timeout',
  'agent api returned status',
  'agent is offline',
  'agent offline',
  'refresh agent connection',
];

/**
 * Check if an error message indicates agent is offline
 * @param {string|Error} error - Error message or Error object
 * @returns {boolean} True if error indicates agent is offline
 */
function isAgentOfflineError(error) {
  if (!error) return false;
  const message = (typeof error === 'string' ? error : error.message || '').toLowerCase();
  return AGENT_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * Extract agent error message from error object
 * @param {Error} error - Error object
 * @returns {string} Agent error message or original error message
 */
function getAgentErrorMessage(error) {
  if (isAgentOfflineError(error)) {
    return 'Agent is offline. Please refresh agent connection in Settings.';
  }
  return error?.message || 'Unknown error';
}

module.exports = {
  isAgentOfflineError,
  getAgentErrorMessage,
  AGENT_ERROR_PATTERNS,
};
