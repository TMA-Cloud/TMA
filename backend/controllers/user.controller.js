const { getUserStorageUsage } = require('../models/user.model');
const checkDiskSpace = require('check-disk-space').default;

const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT || 100 * 1024 * 1024 * 1024);

async function storageUsage(req, res) {
  try {
    const used = await getUserStorageUsage(req.userId);
    const { size, free: diskFree } = await checkDiskSpace(process.env.STORAGE_PATH || __dirname);
    const total = Math.min(size, STORAGE_LIMIT);
    const remainingLimit = Math.max(total - used, 0);
    const free = Math.min(diskFree, remainingLimit);
    res.json({ used, total, free });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { storageUsage };
