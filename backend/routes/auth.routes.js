const express = require('express');
const router = express.Router();
const { signup, login, logout, profile } = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');

router.post('/signup', signup);
router.post('/login', login);
router.post('/logout', logout);
router.get('/profile', authMiddleware, profile);

module.exports = router;
