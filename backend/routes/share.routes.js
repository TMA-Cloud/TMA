const express = require('express');
const { downloadShared } = require('../controllers/share.controller');
const router = express.Router();

router.get('/:token', downloadShared);

module.exports = router;
