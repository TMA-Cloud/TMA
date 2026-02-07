const { invalidateAllSessions } = require('../../models/user.model');
const { deleteAllUserSessions, deleteSession } = require('../../models/session.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Logout from current session
 */
async function logout(req, res) {
  try {
    let userId = req.userId || null;
    let sessionId = null;

    // Try to get userId and sessionId from token (logout may not use authMiddleware)
    try {
      const jwt = require('jsonwebtoken');
      let token;
      if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const t = cookies.find(c => c.startsWith('token='));
        if (t) token = t.slice('token='.length);
      }
      if (!token && req.headers.authorization) {
        token = req.headers.authorization.split(' ')[1];
      }

      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        userId = decoded.id || userId;
        sessionId = decoded.sid || null;
      }
    } catch (err) {
      // If token decode fails, continue without session ID (token might be expired/invalid)
      logger.debug({ err }, 'Could not decode token during logout');
    }

    // Revoke the current session if session ID is available
    if (sessionId && userId) {
      try {
        await deleteSession(sessionId, userId);
      } catch (err) {
        // Log error but don't fail logout if session deletion fails
        logger.warn({ err, userId, sessionId }, 'Failed to revoke session on logout');
      }
    }

    // Log logout event
    if (userId) {
      await logAuditEvent(
        'auth.logout',
        {
          status: 'success',
          resourceType: 'auth',
          resourceId: sessionId || null,
          details: sessionId ? 'User logged out and session revoked' : 'User logged out',
        },
        req
      );
      logger.info({ userId, sessionId }, 'User logged out');
    }

    res.clearCookie('token');
    res.json({ message: 'Logged out' });
  } catch (err) {
    logger.error({ err }, 'Logout error');
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
  }
}

/**
 * Logout from all devices by invalidating all tokens
 * This increments the user's token_version, making all existing tokens invalid
 */
async function logoutAllDevices(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated');
    }

    // Invalidate all sessions
    const newTokenVersion = await invalidateAllSessions(req.userId);

    // Delete all session records
    await deleteAllUserSessions(req.userId);

    // Log the security event
    await logAuditEvent(
      'auth.logout_all',
      {
        status: 'success',
        resourceType: 'auth',
        details: 'User invalidated all active sessions',
      },
      req
    );
    logger.info({ userId: req.userId, newTokenVersion }, 'User logged out from all devices');

    // Clear the current session cookie
    res.clearCookie('token');

    sendSuccess(res, {
      message: 'Successfully logged out from all devices',
      sessionsInvalidated: true,
    });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Logout all devices error');
    sendError(res, 500, 'Failed to logout from all devices', err);
  }
}

module.exports = {
  logout,
  logoutAllDevices,
};
