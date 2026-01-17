const https = require('https');
const http = require('http');
const { getAgentSettings } = require('../models/user.model');
const { logger } = require('../config/logger');

/**
 * Check if agent is online (simple health check)
 * Always performs a fresh check - NO CACHE to avoid stale state
 * @returns {Promise<boolean>} True if agent is online
 */
async function checkAgentStatus() {
  try {
    const settings = await getAgentSettings();

    if (!settings.url) {
      return false;
    }

    const url = new URL(settings.url);
    const healthUrl = `${url.origin}/health`;

    return new Promise(resolve => {
      const requestModule = url.protocol === 'https:' ? https : http;
      let resolved = false;

      const req = requestModule.get(healthUrl, { timeout: 5000 }, res => {
        if (resolved) return;
        resolved = true;
        const isOnline = res.statusCode === 200;
        resolve(isOnline);
      });

      req.on('error', err => {
        if (resolved) return;
        resolved = true;
        // Log for debugging but don't spam
        logger.debug({ err, healthUrl }, 'Agent health check failed');
        resolve(false);
      });

      req.setTimeout(5000, () => {
        if (resolved) return;
        resolved = true;
        req.destroy();
        logger.debug({ healthUrl }, 'Agent health check timeout');
        resolve(false);
      });
    });
  } catch (err) {
    logger.debug({ err }, 'Agent health check error');
    return false;
  }
}

/**
 * Get agent paths from the agent API
 * @returns {Promise<string[]>} Array of configured paths
 */
async function getAgentPaths() {
  const settings = await getAgentSettings();

  if (!settings.url) {
    throw new Error('Agent URL not configured');
  }

  const url = new URL(settings.url);
  const agentUrl = `${url.origin}/api/paths`;

  return new Promise((resolve, reject) => {
    const requestModule = url.protocol === 'https:' ? https : http;

    const options = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    };

    // Add token if configured
    if (settings.token) {
      options.headers['Authorization'] = `Bearer ${settings.token}`;
    }

    const req = requestModule.get(agentUrl, options, res => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.paths || []);
          } catch (_err) {
            reject(new Error('Invalid response from agent'));
          }
        } else {
          reject(new Error(`Agent API returned status ${res.statusCode}`));
        }
      });
    });

    req.on('error', err => {
      reject(new Error(`Failed to connect to agent: ${err.message}`));
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Agent request timeout'));
    });
  });
}

/**
 * Reset agent status (no-op, kept for API compatibility)
 */
function resetAgentStatus() {
  // No cache to reset
}

module.exports = {
  getAgentPaths,
  checkAgentStatus,
  resetAgentStatus,
};
