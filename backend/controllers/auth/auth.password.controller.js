const bcrypt = require('bcryptjs');
const {
  getUserByIdWithPassword,
  updateUserPassword,
  getPasswordChangeSettings,
  invalidateAllSessions,
} = require('../../models/user.model');
const { deleteAllUserSessions } = require('../../models/session.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');

/**
 * Change current user's password
 */
async function changePassword(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated!!');
    }

    const { oldPassword, newPassword } = req.body;

    const allowPasswordChange = await getPasswordChangeSettings();
    if (!allowPasswordChange) {
      return sendError(res, 403, 'Password change is currently disabled by the administrator!!');
    }

    const user = await getUserByIdWithPassword(req.userId);
    if (!user) {
      return sendError(res, 404, 'User not found!!');
    }

    if (!user.password) {
      return sendError(res, 400, 'Password change is not available for this account!!');
    }

    const validOld = await bcrypt.compare(oldPassword, user.password);
    if (!validOld) {
      await logAuditEvent(
        'auth.password_change',
        {
          status: 'failure',
          resourceType: 'auth',
          metadata: { reason: 'invalid_current_password' },
        },
        req
      );
      return sendError(res, 400, 'Current password is incorrect!!');
    }

    if (oldPassword === newPassword) {
      return sendError(res, 400, 'New password must be different from the current password!!');
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await updateUserPassword(req.userId, hashed);

    const newTokenVersion = await invalidateAllSessions(req.userId);
    await deleteAllUserSessions(req.userId);

    await logAuditEvent(
      'auth.password_change',
      {
        status: 'success',
        resourceType: 'auth',
        metadata: { newTokenVersion },
      },
      req
    );
    logger.info({ userId: req.userId }, 'User changed password successfully');

    sendSuccess(res, { message: 'Password changed successfully, Please log in again!' });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to change password!!');
    sendError(res, 500, 'Failed to change password!!', err);
  }
}

module.exports = {
  changePassword,
};
