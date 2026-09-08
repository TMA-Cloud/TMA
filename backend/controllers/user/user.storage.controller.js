import { getUserStorageLimit, getUserStorageUsage } from '../../models/user.model.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Get storage usage information for the current user.
 * S3: total = per-user limit or null (Unlimited); no disk; free = limit - used or null.
 */
async function storageUsage(req, res) {
  const used = await getUserStorageUsage(req.ownerId);
  const userStorageLimit = await getUserStorageLimit(req.ownerId);

  const total = userStorageLimit !== null ? userStorageLimit : null;
  const free = userStorageLimit !== null ? Math.max(0, userStorageLimit - used) : null;
  return sendSuccess(res, { used, total, free });
}

export { storageUsage };
