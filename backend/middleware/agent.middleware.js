const { checkAgentForUser } = require('../utils/agentCheck');
const { sendError } = require('../utils/response');

/**
 * Middleware to check if agent is required and online
 * Returns 503 if agent is required but offline
 */
async function requireAgentOnline(req, res, next) {
  try {
    const agentCheck = await checkAgentForUser(req.userId);
    if (agentCheck.required && !agentCheck.online) {
      return sendError(res, 503, 'Agent is offline. Please refresh agent connection in Settings.');
    }
    // Attach agent check result to request for use in controllers
    req.agentCheck = agentCheck;
    next();
  } catch (_error) {
    return sendError(res, 500, 'Error checking agent status');
  }
}

module.exports = {
  requireAgentOnline,
};
