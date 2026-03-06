import express from 'express';

import { callback, getConfig, getViewerPage, serveFile } from '../controllers/onlyoffice.controller.js';
import auth from '../middleware/auth.middleware.js';
import { apiRateLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { getOnlyOfficeConfigSchema } from '../utils/validationSchemas.js';

const router = express.Router();

// Authenticated: get editor config for a file
router.get('/config/:id', auth, apiRateLimiter, getOnlyOfficeConfigSchema, validate, getConfig);

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

export default router;
