const express = require('express');
const auth = require('../middleware/auth.middleware');
const { storageUsage, getSignupStatus, toggleSignup } = require('../controllers/user.controller');

const router = express.Router();

router.use(auth);

router.get('/storage', storageUsage);
router.get('/signup-status', getSignupStatus);
router.post('/signup-toggle', toggleSignup);

module.exports = router;
