const {
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
} = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');

/**
 * Get signup status and admin information
 */
async function getSignupStatus(req, res) {
  try {
    const signupEnabled = await getSignupEnabled();
    const userIsFirst = await isFirstUser(req.userId);
    let totalUsers;

    if (userIsFirst) {
      totalUsers = await getTotalUserCount();
    }

    sendSuccess(res, {
      signupEnabled,
      canToggle: userIsFirst,
      totalUsers,
      additionalUsers: typeof totalUsers === 'number' ? Math.max(totalUsers - 1, 0) : undefined,
    });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Toggle signup enabled/disabled (admin only)
 */
async function toggleSignup(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'toggle_signup', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized signup toggle attempt');
      return sendError(res, 403, 'Only the first user can toggle signup');
    }

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return sendError(res, 400, 'enabled must be a boolean');
    }

    // setSignupEnabled will do additional security checks internally
    await setSignupEnabled(enabled, req.userId);

    // Log admin action
    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'signup_enabled', newValue: enabled },
      },
      req
    );
    logger.info({ userId: req.userId, signupEnabled: enabled }, 'Signup setting toggled');

    sendSuccess(res, { signupEnabled: enabled });
  } catch (err) {
    if (err.message === 'Only the first user can toggle signup') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'toggle_signup' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized signup toggle attempt');
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to toggle signup');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * List all users (admin only)
 */
async function listUsers(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.user.list',
        {
          status: 'failure',
          resourceType: 'user',
          metadata: { reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized user list attempt');
      return sendError(res, 403, 'Only the first user can view all users');
    }

    const users = (await getAllUsersBasic()).map(user => ({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.created_at,
    }));

    // Log admin action
    await logAuditEvent(
      'admin.user.list',
      {
        status: 'success',
        resourceType: 'user',
        metadata: { userCount: users.length },
      },
      req
    );
    logger.info({ userId: req.userId, userCount: users.length }, 'Users list viewed');

    sendSuccess(res, { users });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch users list');
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  getSignupStatus,
  toggleSignup,
  listUsers,
};
