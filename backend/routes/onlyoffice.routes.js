const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const { getConfig, serveFile, callback, getViewerPage } = require('../controllers/onlyoffice.controller');
const { apiRateLimiter } = require('../middleware/rateLimit.middleware');

// Authenticated: get editor config for a file
router.get('/config/:id', auth, apiRateLimiter, getConfig);

// Authenticated: get standalone viewer HTML page
router.get('/viewer/:id', auth, apiRateLimiter, getViewerPage);

// Public for ONLYOFFICE server: serve file by signed token
router.get('/file/:id', apiRateLimiter, serveFile);
router.options('/file/:id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

// Callback endpoint for ONLYOFFICE server
router.post('/callback', express.json({ limit: '2mb' }), callback);
router.options('/callback', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

module.exports = router;
