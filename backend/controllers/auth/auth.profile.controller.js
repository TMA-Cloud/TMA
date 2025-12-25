const { getUserById } = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');

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

module.exports = {
  profile,
};
