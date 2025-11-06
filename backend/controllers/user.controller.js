const { getUserStorageUsage } = require('../models/user.model');
const checkDiskSpace = require('check-disk-space').default;
const { sendError, sendSuccess } = require('../utils/response');

const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT || 100 * 1024 * 1024 * 1024);

async function storageUsage(req, res) {
  try {
    const used = await getUserStorageUsage(req.userId);
    const { size, free: diskFree } = await checkDiskSpace(process.env.STORAGE_PATH || __dirname);
    const total = Math.min(size, STORAGE_LIMIT);
    const remainingLimit = Math.max(total - used, 0);
    const free = Math.min(diskFree, remainingLimit);
    sendSuccess(res, { used, total, free });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = { storageUsage };
