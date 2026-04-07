import { logger } from '../../config/logger.js';
import { deleteAllHeartbeatsForUser, deleteHeartbeatBySession } from '../../models/clientHeartbeat.model.js';
import { deleteAllUserSessions, deleteSession } from '../../models/session.model.js';
import { invalidateAllSessions } from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { extractTokenFromRequest } from '../../utils/tokenExtractor.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * Logout from current session
 */
async function logout(req, res) {
  try {
    let userId = req.userId || null;
    let sessionId = null;

    // Try to get userId and sessionId from token (logout may not use authMiddleware)
    const decoded = extractTokenFromRequest(req);
    if (decoded) {
      userId = decoded.id || userId;
      sessionId = decoded.sid || null;
    }

    // Revoke the current session if session ID is available
    if (sessionId && userId) {
      try {
        await deleteSession(sessionId, userId);
        await deleteHeartbeatBySession(userId, sessionId);
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
    await deleteAllHeartbeatsForUser(req.userId);

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

export { logout, logoutAllDevices };
