import { getUserById } from '../../models/user.model.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * Get user profile
 */
async function profile(req, res) {
  try {
    const user = await getUserById(req.userId);
    if (!user) {
      return sendError(res, 404, 'Not found');
    }
    sendSuccess(res, user);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

export { profile };
