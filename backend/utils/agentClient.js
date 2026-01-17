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

        // Only consider online if status code is exactly 200
        // Any other status code means agent is not properly online
        const statusCode = res.statusCode;

        if (!statusCode || statusCode !== 200) {
          // Not 200 or undefined - agent is offline
          resolved = true;
          logger.debug({ healthUrl, statusCode }, 'Agent health check returned non-200 status');
          // Consume response to prevent connection issues
          res.on('data', () => {});
          res.on('end', () => {});
          resolve(false);
          return;
        }

        // Status is 200 - consume response and verify it completes successfully
        let responseData = '';
        let dataReceived = false;

        res.on('data', chunk => {
          if (chunk) {
            dataReceived = true;
            responseData += chunk.toString();
          }
        });

        res.on('end', () => {
          if (resolved) return;
          resolved = true;
          // Only resolve true if we got a 200 and response completed successfully
          // Log for debugging
          logger.debug(
            {
              healthUrl,
              statusCode: 200,
              dataLength: responseData.length,
              dataReceived,
            },
            'Agent health check successful'
          );
          resolve(true);
        });

        res.on('error', err => {
          if (resolved) return;
          resolved = true;
          logger.debug({ err, healthUrl }, 'Agent health check response error');
          resolve(false);
        });
      });

      req.on('error', err => {
        if (resolved) return;
        resolved = true;
        // Log for debugging but don't spam
        logger.debug({ err, healthUrl }, 'Agent health check request failed');
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
 * Test agent connection with provided URL and token (without reading from DB)
 * @param {string} url - Agent URL to test
 * @param {string|null} token - Agent token to test (optional)
 * @returns {Promise<{online: boolean, tokenValid: boolean, error?: string}>}
 */
async function testAgentConnection(url, token = null) {
  try {
    if (!url) {
      return { online: false, tokenValid: false, error: 'URL not provided' };
    }

    const urlObj = new URL(url);
    const healthUrl = `${urlObj.origin}/health`;
    const pathsUrl = `${urlObj.origin}/api/paths`;

    const requestModule = urlObj.protocol === 'https:' ? https : http;

    // First check health endpoint
    const isOnline = await new Promise(resolve => {
      let resolved = false;
      const req = requestModule.get(healthUrl, { timeout: 5000 }, res => {
        if (resolved) return;
        resolved = true;
        resolve(res.statusCode === 200);
      });

      req.on('error', () => {
        if (resolved) return;
        resolved = true;
        resolve(false);
      });

      req.setTimeout(5000, () => {
        if (resolved) return;
        resolved = true;
        req.destroy();
        resolve(false);
      });
    });

    if (!isOnline) {
      return { online: false, tokenValid: false, error: 'Connection failed' };
    }

    // If token provided, test it by getting paths
    if (token) {
      const tokenValid = await new Promise(resolve => {
        let resolved = false;
        const options = {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          timeout: 5000,
        };

        const req = requestModule.get(pathsUrl, options, res => {
          if (resolved) return;
          resolved = true;
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve(false);
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            resolve(false);
          }
        });

        req.on('error', () => {
          if (resolved) return;
          resolved = true;
          resolve(false);
        });

        req.setTimeout(5000, () => {
          if (resolved) return;
          resolved = true;
          req.destroy();
          resolve(false);
        });
      });

      if (!tokenValid) {
        return { online: true, tokenValid: false, error: 'Invalid token' };
      }
    }

    return { online: true, tokenValid: token !== null };
  } catch (err) {
    logger.debug({ err, url }, 'Agent connection test error');
    return { online: false, tokenValid: false, error: 'Connection failed' };
  }
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
  testAgentConnection,
};
