const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const auth = require('../middleware/auth.middleware');

const router = express.Router();

router.use(auth);

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
    console.error('Error reading package version:', error);
    return 'unknown';
  }
}

// Backend version - read once at startup
const backendVersion = readPackageVersion(path.join(__dirname, '..', 'package.json'));

router.get('/', (_req, res) => {
  res.json({
    backend: backendVersion,
  });
});

// Proxy endpoint to fetch latest versions from GitHub (avoids CORS issues)
router.get('/latest', (req, res) => {
  const url = 'https://tma-cloud.github.io/updates/versions.json';
  let responseSent = false;
  
  const sendError = (statusCode, message) => {
    if (!responseSent) {
      responseSent = true;
      res.status(statusCode).json({ error: message });
    }
  };
  
  const request = https.get(url, (httpsRes) => {
    // Check response status code
    if (httpsRes.statusCode !== 200) {
      sendError(502, `GitHub returned status ${httpsRes.statusCode}`);
      return;
    }
    
    let data = '';
    
    // Handle response stream errors
    httpsRes.on('error', (error) => {
      console.error('Error reading response stream:', error);
      sendError(502, 'Error reading response from GitHub');
    });
    
    httpsRes.on('data', (chunk) => {
      data += chunk;
    });
    
    httpsRes.on('end', () => {
      if (responseSent) return;
      
      try {
        const versions = JSON.parse(data);
        responseSent = true;
        res.json(versions);
      } catch (error) {
        console.error('Error parsing versions JSON:', error);
        sendError(500, 'Failed to parse versions data');
      }
    });
  });
  
  // Handle request-level errors
  request.on('error', (error) => {
    console.error('Error fetching latest versions:', error);
    sendError(500, 'Failed to fetch latest versions');
  });
  
  // Set timeout to prevent hanging requests (10 seconds)
  request.setTimeout(10000, () => {
    request.destroy();
    sendError(504, 'Request timeout while fetching versions');
  });
});

module.exports = router;

