const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const auth = require('../middleware/auth.middleware');
const { isFirstUser } = require('../models/user.model');
const { sendError } = require('../utils/response');
const { logger } = require('../config/logger');
const { apiRateLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

router.use(auth);
router.use(apiRateLimiter);

// Middleware to check if user is admin (first user)
async function requireAdmin(req, res, next) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      logger.warn({ userId: req.userId }, 'Unauthorized version check attempt');
      return sendError(res, 403, 'Only the admin can check for updates');
    }
    next();
  } catch (err) {
    logger.error({ err }, 'Failed to check admin status');
    return sendError(res, 500, 'Server error');
  }
}

function readPackageVersion(packagePath) {
  try {
    if (!fs.existsSync(packagePath)) {
      return 'unknown';
    }
    // Read synchronously at startup to avoid IO on every request
    const fileContents = fs.readFileSync(packagePath, 'utf8');
    const parsed = JSON.parse(fileContents);
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch (error) {
    logger.error({ err: error }, 'Error reading package version');
    return 'unknown';
  }
}

// Backend version - read once at startup
const backendVersion = readPackageVersion(path.join(__dirname, '..', 'package.json'));

router.get('/', (_req, res) => {
  res.json({ backend: backendVersion });
});

// Proxy endpoint to fetch latest versions from GitHub (avoids CORS issues)
// Only admin (first user) can check for updates
router.get('/latest', requireAdmin, (req, res) => {
  const url = 'https://tma-cloud.github.io/updates/versions.json';
  let responseSent = false;

  const sendLocalError = (statusCode, message) => {
    if (!responseSent) {
      responseSent = true;
      res.status(statusCode).json({ error: message });
    }
  };

  const request = https.get(url, httpsRes => {
    // Check response status code
    if (httpsRes.statusCode !== 200) {
      sendLocalError(502, `GitHub returned status ${httpsRes.statusCode}`);
      return;
    }

    let data = '';

    // Handle response stream errors
    httpsRes.on('error', error => {
      logger.error({ err: error }, 'Error reading response stream');
      sendLocalError(502, 'Error reading response from GitHub');
    });

    httpsRes.on('data', chunk => {
      data += chunk;
    });

    httpsRes.on('end', () => {
      if (responseSent) return;

      try {
        const versions = JSON.parse(data);
        responseSent = true;
        res.json({
          frontend: versions.frontend ?? 'unknown',
          backend: versions.backend ?? 'unknown',
        });
      } catch (error) {
        logger.error({ err: error }, 'Error parsing versions JSON');
        sendLocalError(500, 'Failed to parse versions data');
      }
    });
  });

  // Handle request-level errors
  request.on('error', error => {
    logger.error({ err: error }, 'Error fetching latest versions');
    sendLocalError(500, 'Failed to fetch latest versions');
  });

  // Set timeout to prevent hanging requests (10 seconds)
  request.setTimeout(10000, () => {
    request.destroy();
    sendLocalError(504, 'Request timeout while fetching versions');
  });
});

module.exports = router;
