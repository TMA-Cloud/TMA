import { getUserById } from '../../models/user.model.js';
import { ALL_PERMISSIONS } from '../../utils/permissions.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * Get user profile
 *
 * Also reports the account context so the UI knows whether this login is a
 * sub-user and whether it may modify files.
 */
async function profile(req, res) {
  try {
    const user = await getUserById(req.userId);
    if (!user) {
      return sendError(res, 404, 'Not found');
    }
    sendSuccess(res, {
      ...user,
      isSubUser: Boolean(req.isSubUser),
      // Owners hold every capability; sub-users get exactly what was granted.
      permissions: req.isSubUser ? req.permissions : ALL_PERMISSIONS,
    });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

export { profile };
