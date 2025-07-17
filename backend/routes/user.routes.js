const express = require('express');
const auth = require('../middleware/auth.middleware');
const { storageUsage } = require('../controllers/user.controller');

const router = express.Router();

router.use(auth);

router.get('/storage', storageUsage);

module.exports = router;
